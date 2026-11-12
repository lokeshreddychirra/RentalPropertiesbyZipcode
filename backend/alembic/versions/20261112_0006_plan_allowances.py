"""New Pro and Premium allowances: Pro 5 ZIP searches and 20 property reports a month, Premium 15 and 60.

Updates allowances an administrator saved earlier (prices are kept). Plans without a saved row use the
new defaults in ``app/core/config.py``. Administrators can still change every value in the admin portal.

Revision ID: 0006
Revises: 0005
"""

from alembic import op

revision = "0006"
down_revision = "0005"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("UPDATE plan_configs SET zip_searches = 5, property_reports = 20, updated_at = now() WHERE key = 'pro'")
    op.execute("UPDATE plan_configs SET zip_searches = 15, property_reports = 60, updated_at = now() WHERE key = 'premium'")


def downgrade() -> None:
    # Allowances are business settings; restore earlier values in the admin portal if needed.
    pass
