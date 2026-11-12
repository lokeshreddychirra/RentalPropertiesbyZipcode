"""Admin-configurable cache settings; record when each cached provider response was fetched.

Revision ID: 0005
Revises: 0004
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0005"
down_revision = "0004"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("provider_response_cache", sa.Column("fetched_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False))
    op.execute("UPDATE provider_response_cache SET fetched_at = created_at")
    op.create_table(
        "app_settings",
        sa.Column("key", sa.String(length=60), nullable=False),
        sa.Column("value", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.PrimaryKeyConstraint("key"),
    )


def downgrade() -> None:
    op.drop_table("app_settings")
    op.drop_column("provider_response_cache", "fetched_at")
