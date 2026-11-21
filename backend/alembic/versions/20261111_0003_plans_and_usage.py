"""Subscription plans, per-user usage and login tracking.

Revision ID: 0003
Revises: 0002
"""

import sqlalchemy as sa
from alembic import op

revision = "0003"
down_revision = "0002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("users", sa.Column("plan", sa.String(length=20), server_default="free", nullable=False))
    op.add_column("users", sa.Column("plan_status", sa.String(length=30), nullable=True))
    op.add_column("users", sa.Column("plan_renews_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("users", sa.Column("stripe_customer_id", sa.String(length=64), nullable=True))
    op.add_column("users", sa.Column("stripe_subscription_id", sa.String(length=64), nullable=True))
    op.add_column("users", sa.Column("last_login_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("users", sa.Column("login_count", sa.Integer(), server_default="0", nullable=False))
    op.create_index("ix_users_stripe_customer_id", "users", ["stripe_customer_id"])
    op.create_table(
        "user_usage",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("user_id", sa.UUID(), nullable=False),
        sa.Column("kind", sa.String(length=30), nullable=False),
        sa.Column("item", sa.String(length=64), nullable=False),
        sa.Column("period", sa.String(length=10), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("user_id", "kind", "item", "period"),
    )
    op.create_index("ix_user_usage_user_id", "user_usage", ["user_id"])
    op.create_table(
        "plan_configs",
        sa.Column("key", sa.String(length=20), nullable=False),
        sa.Column("price_usd", sa.Numeric(10, 2), nullable=False),
        sa.Column("zip_searches", sa.Integer(), nullable=True),
        sa.Column("property_reports", sa.Integer(), nullable=True),
        sa.Column("zips_per_search", sa.Integer(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.PrimaryKeyConstraint("key"),
    )


def downgrade() -> None:
    op.drop_table("plan_configs")
    op.drop_index("ix_user_usage_user_id", table_name="user_usage")
    op.drop_table("user_usage")
    op.drop_index("ix_users_stripe_customer_id", table_name="users")
    for column in ("login_count", "last_login_at", "stripe_subscription_id", "stripe_customer_id", "plan_renews_at", "plan_status", "plan"):
        op.drop_column("users", column)
