"""Persistent cache of paid provider responses (listing pages).

Revision ID: 0004
Revises: 0003
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0004"
down_revision = "0003"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "provider_response_cache",
        sa.Column("key", sa.String(length=80), nullable=False),
        sa.Column("kind", sa.String(length=20), nullable=False),
        sa.Column("payload", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.PrimaryKeyConstraint("key"),
    )
    op.create_index("ix_provider_response_cache_expires_at", "provider_response_cache", ["expires_at"])


def downgrade() -> None:
    op.drop_index("ix_provider_response_cache_expires_at", table_name="provider_response_cache")
    op.drop_table("provider_response_cache")
