"""RentCast budget for the Foundation plan: 500 requests a month (a safety limit below the 1,000 included).

Cost per request is the plan's effective price ($74 for 1,000 requests); the cost limit is the plan
price, so the 500 request limit is what stops searches. Administrators can raise either value under
Admin Portal -> API usage.

Revision ID: 0008
Revises: 0007
"""

from alembic import op

revision = "0008"
down_revision = "0007"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        "UPDATE providers SET monthly_request_limit = 500, monthly_cost_limit_usd = 74, cost_per_request_usd = 0.074, updated_at = now() "
        "WHERE key = 'rentcast'"
    )


def downgrade() -> None:
    pass
