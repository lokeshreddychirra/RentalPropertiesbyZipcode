"""Save the Pro and Premium allowances as admin settings when no saved row exists.

Revision 0006 only updated saved rows, so a plan without one kept whatever the environment set
(for example PLAN_PREMIUM_* in the hosting dashboard). Saved rows take precedence over environment
values, so this makes the new allowances apply everywhere. Existing rows are left alone.

Revision ID: 0007
Revises: 0006
"""

from alembic import op

revision = "0007"
down_revision = "0006"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        "INSERT INTO plan_configs (key, price_usd, zip_searches, property_reports, zips_per_search) "
        "VALUES ('pro', 19, 5, 20, 1), ('premium', 49, 15, 60, 1) ON CONFLICT (key) DO NOTHING"
    )


def downgrade() -> None:
    pass
