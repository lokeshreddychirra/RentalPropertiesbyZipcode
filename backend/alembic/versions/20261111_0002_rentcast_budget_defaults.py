"""Lower RentCast's untouched default budget to the Developer plan's included quota.

The original seed (1,000 requests / $50 at $0.02 a request) did not match RentCast's pricing,
where the Developer plan includes 50 requests a month and further requests cost about $0.20.
Only values still at the old defaults are changed, so budgets an administrator has set are kept.

Revision ID: 0002
Revises: 0001
"""

from alembic import op

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("UPDATE providers SET monthly_request_limit = 50 WHERE key = 'rentcast' AND monthly_request_limit = 1000")
    op.execute("UPDATE providers SET monthly_cost_limit_usd = 25 WHERE key = 'rentcast' AND monthly_cost_limit_usd = 50")
    op.execute("UPDATE providers SET cost_per_request_usd = 0.20 WHERE key = 'rentcast' AND cost_per_request_usd = 0.02")


def downgrade() -> None:
    pass
