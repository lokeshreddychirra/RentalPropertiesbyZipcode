"""Shared HTTP client for provider adapters.

Handles, in one place, everything the spec requires of external calls:
client-side rate limiting, retries with backoff (honouring ``Retry-After``),
budget checks before paid requests, and usage / error accounting.
"""

from __future__ import annotations

import asyncio
import logging
import random
import time
from typing import Any

import httpx

from .base import ProviderAuthError, ProviderError, ProviderRateLimited
from .usage import UsageTracker, get_usage_tracker

logger = logging.getLogger(__name__)


class RateLimiter:
    """Spaces requests at least ``1 / rate`` seconds apart (per process)."""

    def __init__(self, requests_per_second: float):
        self._interval = 1.0 / requests_per_second if requests_per_second > 0 else 0.0
        self._lock = asyncio.Lock()
        self._next = 0.0

    async def acquire(self) -> None:
        if self._interval <= 0:
            return
        async with self._lock:
            now = time.monotonic()
            wait = self._next - now
            self._next = max(now, self._next) + self._interval
        if wait > 0:
            await asyncio.sleep(wait)


class ProviderHTTPClient:
    def __init__(
        self,
        provider: str,
        base_url: str,
        *,
        headers: dict[str, str] | None = None,
        requests_per_second: float = 5.0,
        timeout: float = 30.0,
        max_retries: int = 3,
        tracker: UsageTracker | None = None,
        transport: httpx.AsyncBaseTransport | None = None,
    ):
        self.provider = provider
        self._client = httpx.AsyncClient(base_url=base_url, headers=headers or {}, timeout=timeout, transport=transport)
        self._limiter = RateLimiter(requests_per_second)
        self._max_retries = max_retries
        self._tracker = tracker or get_usage_tracker()

    async def aclose(self) -> None:
        await self._client.aclose()

    async def request(
        self,
        method: str,
        path: str,
        *,
        params: dict[str, Any] | None = None,
        json: Any | None = None,
        endpoint: str | None = None,
        not_found_ok: bool = False,
    ) -> httpx.Response | None:
        """Perform a request. Returns None for 404 when ``not_found_ok`` is set.

        Raises BudgetExceeded before sending when the monthly budget is exhausted.
        """
        label = endpoint or path
        clean_params = {k: v for k, v in (params or {}).items() if v is not None}
        attempt = 0
        while True:
            attempt += 1
            await self._tracker.check_budget(self.provider)
            await self._limiter.acquire()
            started = time.monotonic()
            try:
                response = await self._client.request(method, path, params=clean_params, json=json)
            except httpx.HTTPError as exc:
                duration = int((time.monotonic() - started) * 1000)
                await self._tracker.record(self.provider, label, ok=False, status_code=None, duration_ms=duration, billable=False, error=type(exc).__name__)
                if attempt <= self._max_retries:
                    await asyncio.sleep(self._backoff(attempt))
                    continue
                raise ProviderError(self.provider, f"network error calling {label}: {type(exc).__name__}", retryable=True) from exc

            duration = int((time.monotonic() - started) * 1000)
            status = response.status_code
            ok = status < 400 or (status == 404 and not_found_ok)
            # Providers bill successful lookups; throttled and failed calls are not billable.
            await self._tracker.record(
                self.provider, label, ok=ok, status_code=status, duration_ms=duration, billable=status < 400, error=None if ok else f"HTTP {status}"
            )

            if status < 400:
                return response
            if status == 404 and not_found_ok:
                return None
            if status in (401, 403):
                raise ProviderAuthError(self.provider, f"authentication failed (HTTP {status}) — check the API key and plan", status_code=status)
            if status == 429 or status >= 500:
                if attempt <= self._max_retries:
                    await asyncio.sleep(self._retry_after(response) or self._backoff(attempt))
                    continue
                if status == 429:
                    raise ProviderRateLimited(self.provider)
                raise ProviderError(self.provider, f"{label} failed with HTTP {status}", status_code=status, retryable=True)
            raise ProviderError(self.provider, f"{label} rejected the request (HTTP {status}): {response.text[:200]}", status_code=status)

    async def get_json(self, path: str, **kwargs: Any) -> Any | None:
        response = await self.request("GET", path, **kwargs)
        return None if response is None else response.json()

    @staticmethod
    def _backoff(attempt: int) -> float:
        return min(2 ** (attempt - 1), 20) + random.uniform(0, 0.4)

    @staticmethod
    def _retry_after(response: httpx.Response) -> float | None:
        value = response.headers.get("Retry-After")
        if not value:
            return None
        try:
            return min(float(value), 60.0)
        except ValueError:
            return None
