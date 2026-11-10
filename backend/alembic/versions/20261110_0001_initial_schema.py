"""initial schema

Revision ID: 0001
Revises: 
Create Date: 2026-11-10 03:57:30.834482
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from geoalchemy2 import Geography
from sqlalchemy.dialects import postgresql

revision: str = '0001'
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute("CREATE EXTENSION IF NOT EXISTS postgis")
    op.create_table('market_snapshots',
    sa.Column('id', sa.UUID(), nullable=False),
    sa.Column('zip_code', sa.String(length=10), nullable=False),
    sa.Column('provider_key', sa.String(length=40), nullable=False),
    sa.Column('data', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
    sa.Column('fetched_at', sa.DateTime(timezone=True), nullable=False),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('zip_code', 'provider_key')
    )
    op.create_index(op.f('ix_market_snapshots_zip_code'), 'market_snapshots', ['zip_code'], unique=False)
    op.create_geospatial_table('properties',
    sa.Column('id', sa.UUID(), nullable=False),
    sa.Column('dedupe_key', sa.String(length=255), nullable=False),
    sa.Column('formatted_address', sa.String(length=300), nullable=False),
    sa.Column('address_line1', sa.String(length=200), nullable=True),
    sa.Column('address_line2', sa.String(length=80), nullable=True),
    sa.Column('city', sa.String(length=120), nullable=True),
    sa.Column('state', sa.String(length=2), nullable=True),
    sa.Column('zip_code', sa.String(length=10), nullable=True),
    sa.Column('county', sa.String(length=120), nullable=True),
    sa.Column('latitude', sa.Numeric(precision=9, scale=6), nullable=True),
    sa.Column('longitude', sa.Numeric(precision=9, scale=6), nullable=True),
    sa.Column('location', Geography(geometry_type='POINT', srid=4326, dimension=2, spatial_index=False, from_text='ST_GeogFromText', name='geography'), nullable=True),
    sa.Column('property_type', sa.String(length=30), nullable=True),
    sa.Column('bedrooms', sa.Numeric(precision=4, scale=1), nullable=True),
    sa.Column('bathrooms', sa.Numeric(precision=4, scale=1), nullable=True),
    sa.Column('square_feet', sa.Integer(), nullable=True),
    sa.Column('lot_size_sqft', sa.Integer(), nullable=True),
    sa.Column('year_built', sa.Integer(), nullable=True),
    sa.Column('is_demo', sa.Boolean(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('dedupe_key')
    )
    op.create_index(op.f('ix_properties_is_demo'), 'properties', ['is_demo'], unique=False)
    op.create_geospatial_index('ix_properties_location', 'properties', ['location'], unique=False, postgresql_using='gist', postgresql_ops={})
    op.create_index('ix_properties_state_city', 'properties', ['state', 'city'], unique=False)
    op.create_index(op.f('ix_properties_zip_code'), 'properties', ['zip_code'], unique=False)
    op.create_table('providers',
    sa.Column('key', sa.String(length=40), nullable=False),
    sa.Column('name', sa.String(length=80), nullable=False),
    sa.Column('kind', sa.String(length=40), nullable=False),
    sa.Column('attribution', sa.String(length=255), nullable=True),
    sa.Column('terms_url', sa.String(length=500), nullable=True),
    sa.Column('enabled', sa.Boolean(), nullable=False),
    sa.Column('monthly_request_limit', sa.Integer(), nullable=True),
    sa.Column('monthly_cost_limit_usd', sa.Numeric(precision=12, scale=2), nullable=True),
    sa.Column('cost_per_request_usd', sa.Numeric(precision=10, scale=5), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.PrimaryKeyConstraint('key')
    )
    op.create_table('users',
    sa.Column('id', sa.UUID(), nullable=False),
    sa.Column('email', sa.String(length=320), nullable=False),
    sa.Column('password_hash', sa.String(length=255), nullable=False),
    sa.Column('name', sa.String(length=120), nullable=True),
    sa.Column('role', sa.String(length=20), nullable=False),
    sa.Column('is_active', sa.Boolean(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.PrimaryKeyConstraint('id')
    )
    op.create_index(op.f('ix_users_email'), 'users', ['email'], unique=True)
    op.create_table('financing_scenarios',
    sa.Column('id', sa.UUID(), nullable=False),
    sa.Column('user_id', sa.UUID(), nullable=False),
    sa.Column('property_id', sa.UUID(), nullable=True),
    sa.Column('name', sa.String(length=80), nullable=False),
    sa.Column('down_payment_pct', sa.Numeric(precision=7, scale=3), nullable=False),
    sa.Column('interest_rate_pct', sa.Numeric(precision=7, scale=3), nullable=False),
    sa.Column('loan_term_years', sa.Integer(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.ForeignKeyConstraint(['property_id'], ['properties.id'], ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['user_id'], ['users.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id')
    )
    op.create_index(op.f('ix_financing_scenarios_user_id'), 'financing_scenarios', ['user_id'], unique=False)
    op.create_table('investment_analyses',
    sa.Column('id', sa.UUID(), nullable=False),
    sa.Column('user_id', sa.UUID(), nullable=False),
    sa.Column('property_id', sa.UUID(), nullable=False),
    sa.Column('name', sa.String(length=120), nullable=True),
    sa.Column('overrides', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
    sa.Column('assumptions', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
    sa.Column('summary', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
    sa.Column('recommended_strategy', sa.String(length=4), nullable=True),
    sa.Column('score', sa.Numeric(precision=5, scale=1), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.ForeignKeyConstraint(['property_id'], ['properties.id'], ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['user_id'], ['users.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id')
    )
    op.create_index(op.f('ix_investment_analyses_property_id'), 'investment_analyses', ['property_id'], unique=False)
    op.create_index(op.f('ix_investment_analyses_user_id'), 'investment_analyses', ['user_id'], unique=False)
    op.create_table('property_expenses',
    sa.Column('id', sa.UUID(), nullable=False),
    sa.Column('property_id', sa.UUID(), nullable=False),
    sa.Column('kind', sa.String(length=30), nullable=False),
    sa.Column('annual_amount', sa.Numeric(precision=14, scale=2), nullable=False),
    sa.Column('year', sa.Integer(), nullable=False),
    sa.Column('source', sa.String(length=60), nullable=False),
    sa.Column('provider_key', sa.String(length=40), nullable=False),
    sa.Column('fetched_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.ForeignKeyConstraint(['property_id'], ['properties.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('property_id', 'kind', 'year')
    )
    op.create_index(op.f('ix_property_expenses_property_id'), 'property_expenses', ['property_id'], unique=False)
    op.create_table('property_images',
    sa.Column('id', sa.UUID(), nullable=False),
    sa.Column('property_id', sa.UUID(), nullable=False),
    sa.Column('url', sa.String(length=1000), nullable=False),
    sa.Column('position', sa.Integer(), nullable=False),
    sa.Column('provider_key', sa.String(length=40), nullable=False),
    sa.Column('attribution', sa.String(length=255), nullable=True),
    sa.ForeignKeyConstraint(['property_id'], ['properties.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('property_id', 'url')
    )
    op.create_index(op.f('ix_property_images_property_id'), 'property_images', ['property_id'], unique=False)
    op.create_table('property_listings',
    sa.Column('id', sa.UUID(), nullable=False),
    sa.Column('property_id', sa.UUID(), nullable=False),
    sa.Column('status', sa.String(length=20), nullable=False),
    sa.Column('listing_type', sa.String(length=40), nullable=True),
    sa.Column('price', sa.Numeric(precision=14, scale=2), nullable=True),
    sa.Column('listed_date', sa.Date(), nullable=True),
    sa.Column('removed_date', sa.Date(), nullable=True),
    sa.Column('days_on_market', sa.Integer(), nullable=True),
    sa.Column('hoa_fee_monthly', sa.Numeric(precision=14, scale=2), nullable=True),
    sa.Column('description', sa.Text(), nullable=True),
    sa.Column('listing_url', sa.String(length=1000), nullable=True),
    sa.Column('mls_name', sa.String(length=120), nullable=True),
    sa.Column('mls_number', sa.String(length=60), nullable=True),
    sa.Column('agent_name', sa.String(length=160), nullable=True),
    sa.Column('office_name', sa.String(length=160), nullable=True),
    sa.Column('primary_provider', sa.String(length=40), nullable=False),
    sa.Column('last_seen_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('source_updated_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.ForeignKeyConstraint(['property_id'], ['properties.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('property_id')
    )
    op.create_index(op.f('ix_property_listings_price'), 'property_listings', ['price'], unique=False)
    op.create_index(op.f('ix_property_listings_status'), 'property_listings', ['status'], unique=False)
    op.create_table('property_price_history',
    sa.Column('id', sa.UUID(), nullable=False),
    sa.Column('property_id', sa.UUID(), nullable=False),
    sa.Column('event_date', sa.Date(), nullable=False),
    sa.Column('event_type', sa.String(length=40), nullable=False),
    sa.Column('price', sa.Numeric(precision=14, scale=2), nullable=True),
    sa.Column('provider_key', sa.String(length=40), nullable=False),
    sa.ForeignKeyConstraint(['property_id'], ['properties.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('property_id', 'event_date', 'event_type', 'price')
    )
    op.create_index(op.f('ix_property_price_history_property_id'), 'property_price_history', ['property_id'], unique=False)
    op.create_table('provider_api_usage',
    sa.Column('id', sa.BigInteger(), autoincrement=True, nullable=False),
    sa.Column('provider_key', sa.String(length=40), nullable=False),
    sa.Column('endpoint', sa.String(length=120), nullable=False),
    sa.Column('status_code', sa.Integer(), nullable=True),
    sa.Column('ok', sa.Boolean(), nullable=False),
    sa.Column('cost_usd', sa.Numeric(precision=10, scale=5), nullable=False),
    sa.Column('duration_ms', sa.Integer(), nullable=True),
    sa.Column('error', sa.String(length=500), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.ForeignKeyConstraint(['provider_key'], ['providers.key'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id')
    )
    op.create_index('ix_provider_api_usage_provider_created', 'provider_api_usage', ['provider_key', 'created_at'], unique=False)
    op.create_table('rent_estimates',
    sa.Column('id', sa.UUID(), nullable=False),
    sa.Column('property_id', sa.UUID(), nullable=False),
    sa.Column('provider_key', sa.String(length=40), nullable=False),
    sa.Column('level', sa.String(length=20), nullable=False),
    sa.Column('rent', sa.Numeric(precision=14, scale=2), nullable=False),
    sa.Column('rent_low', sa.Numeric(precision=14, scale=2), nullable=True),
    sa.Column('rent_high', sa.Numeric(precision=14, scale=2), nullable=True),
    sa.Column('comp_count', sa.Integer(), nullable=False),
    sa.Column('market_sample', sa.Integer(), nullable=False),
    sa.Column('fetched_at', sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['property_id'], ['properties.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('property_id', 'provider_key', 'level')
    )
    op.create_index(op.f('ix_rent_estimates_property_id'), 'rent_estimates', ['property_id'], unique=False)
    op.create_table('saved_searches',
    sa.Column('id', sa.UUID(), nullable=False),
    sa.Column('user_id', sa.UUID(), nullable=False),
    sa.Column('name', sa.String(length=120), nullable=False),
    sa.Column('filters', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
    sa.Column('overrides', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
    sa.Column('alerts_enabled', sa.Boolean(), nullable=False),
    sa.Column('notify_new_listings', sa.Boolean(), nullable=False),
    sa.Column('notify_price_reductions', sa.Boolean(), nullable=False),
    sa.Column('cash_flow_threshold', sa.Numeric(precision=14, scale=2), nullable=True),
    sa.Column('gross_yield_threshold', sa.Numeric(precision=7, scale=3), nullable=True),
    sa.Column('known_listings', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
    sa.Column('last_checked_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.ForeignKeyConstraint(['user_id'], ['users.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id')
    )
    op.create_index(op.f('ix_saved_searches_user_id'), 'saved_searches', ['user_id'], unique=False)
    op.create_table('short_term_rental_estimates',
    sa.Column('id', sa.UUID(), nullable=False),
    sa.Column('property_id', sa.UUID(), nullable=False),
    sa.Column('provider_key', sa.String(length=40), nullable=False),
    sa.Column('level', sa.String(length=20), nullable=False),
    sa.Column('adr', sa.Numeric(precision=14, scale=2), nullable=False),
    sa.Column('occupancy_pct', sa.Numeric(precision=7, scale=3), nullable=False),
    sa.Column('occupancy_basis', sa.String(length=12), nullable=False),
    sa.Column('annual_revenue', sa.Numeric(precision=14, scale=2), nullable=True),
    sa.Column('cleaning_fee', sa.Numeric(precision=14, scale=2), nullable=True),
    sa.Column('adr_includes_cleaning_fee', sa.Boolean(), nullable=False),
    sa.Column('avg_stay_nights', sa.Numeric(precision=5, scale=2), nullable=True),
    sa.Column('seasonality', postgresql.JSONB(astext_type=sa.Text()), nullable=True),
    sa.Column('comp_count', sa.Integer(), nullable=False),
    sa.Column('fetched_at', sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['property_id'], ['properties.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('property_id', 'provider_key')
    )
    op.create_index(op.f('ix_short_term_rental_estimates_property_id'), 'short_term_rental_estimates', ['property_id'], unique=False)
    op.create_table('str_regulations',
    sa.Column('id', sa.UUID(), nullable=False),
    sa.Column('jurisdiction_type', sa.String(length=10), nullable=False),
    sa.Column('jurisdiction_key', sa.String(length=160), nullable=False),
    sa.Column('status', sa.String(length=12), nullable=False),
    sa.Column('summary', sa.Text(), nullable=True),
    sa.Column('max_nights_per_year', sa.Integer(), nullable=True),
    sa.Column('source_url', sa.String(length=1000), nullable=True),
    sa.Column('verified_at', sa.Date(), nullable=True),
    sa.Column('verified_by', sa.UUID(), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.ForeignKeyConstraint(['verified_by'], ['users.id'], ondelete='SET NULL'),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('jurisdiction_type', 'jurisdiction_key')
    )
    op.create_table('user_preferences',
    sa.Column('user_id', sa.UUID(), nullable=False),
    sa.Column('default_assumptions', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
    sa.Column('score_weights', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
    sa.Column('notification_settings', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.ForeignKeyConstraint(['user_id'], ['users.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('user_id')
    )
    op.create_table('value_estimates',
    sa.Column('id', sa.UUID(), nullable=False),
    sa.Column('property_id', sa.UUID(), nullable=False),
    sa.Column('provider_key', sa.String(length=40), nullable=False),
    sa.Column('value', sa.Numeric(precision=14, scale=2), nullable=False),
    sa.Column('value_low', sa.Numeric(precision=14, scale=2), nullable=True),
    sa.Column('value_high', sa.Numeric(precision=14, scale=2), nullable=True),
    sa.Column('comp_count', sa.Integer(), nullable=False),
    sa.Column('fetched_at', sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['property_id'], ['properties.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('property_id', 'provider_key')
    )
    op.create_index(op.f('ix_value_estimates_property_id'), 'value_estimates', ['property_id'], unique=False)
    op.create_table('watchlists',
    sa.Column('id', sa.UUID(), nullable=False),
    sa.Column('user_id', sa.UUID(), nullable=False),
    sa.Column('name', sa.String(length=80), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.ForeignKeyConstraint(['user_id'], ['users.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('user_id', 'name')
    )
    op.create_index(op.f('ix_watchlists_user_id'), 'watchlists', ['user_id'], unique=False)
    op.create_table('favorite_properties',
    sa.Column('id', sa.UUID(), nullable=False),
    sa.Column('user_id', sa.UUID(), nullable=False),
    sa.Column('property_id', sa.UUID(), nullable=False),
    sa.Column('watchlist_id', sa.UUID(), nullable=True),
    sa.Column('notes', sa.Text(), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.ForeignKeyConstraint(['property_id'], ['properties.id'], ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['user_id'], ['users.id'], ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['watchlist_id'], ['watchlists.id'], ondelete='SET NULL'),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('user_id', 'property_id')
    )
    op.create_index(op.f('ix_favorite_properties_user_id'), 'favorite_properties', ['user_id'], unique=False)
    op.create_table('notifications',
    sa.Column('id', sa.UUID(), nullable=False),
    sa.Column('user_id', sa.UUID(), nullable=False),
    sa.Column('saved_search_id', sa.UUID(), nullable=True),
    sa.Column('property_id', sa.UUID(), nullable=True),
    sa.Column('type', sa.String(length=30), nullable=False),
    sa.Column('title', sa.String(length=200), nullable=False),
    sa.Column('body', sa.Text(), nullable=False),
    sa.Column('payload', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
    sa.Column('dedupe_key', sa.String(length=200), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('read_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('emailed_at', sa.DateTime(timezone=True), nullable=True),
    sa.ForeignKeyConstraint(['property_id'], ['properties.id'], ondelete='SET NULL'),
    sa.ForeignKeyConstraint(['saved_search_id'], ['saved_searches.id'], ondelete='SET NULL'),
    sa.ForeignKeyConstraint(['user_id'], ['users.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('user_id', 'dedupe_key')
    )
    op.create_index(op.f('ix_notifications_user_id'), 'notifications', ['user_id'], unique=False)
    op.create_table('property_listing_sources',
    sa.Column('id', sa.UUID(), nullable=False),
    sa.Column('listing_id', sa.UUID(), nullable=False),
    sa.Column('provider_key', sa.String(length=40), nullable=False),
    sa.Column('provider_listing_id', sa.String(length=255), nullable=False),
    sa.Column('price', sa.Numeric(precision=14, scale=2), nullable=True),
    sa.Column('status', sa.String(length=20), nullable=True),
    sa.Column('source_url', sa.String(length=1000), nullable=True),
    sa.Column('fetched_at', sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['listing_id'], ['property_listings.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('provider_key', 'provider_listing_id')
    )
    op.create_index(op.f('ix_property_listing_sources_listing_id'), 'property_listing_sources', ['listing_id'], unique=False)
    op.create_table('rental_comparables',
    sa.Column('id', sa.UUID(), nullable=False),
    sa.Column('rent_estimate_id', sa.UUID(), nullable=False),
    sa.Column('formatted_address', sa.String(length=300), nullable=False),
    sa.Column('latitude', sa.Numeric(precision=9, scale=6), nullable=True),
    sa.Column('longitude', sa.Numeric(precision=9, scale=6), nullable=True),
    sa.Column('rent', sa.Numeric(precision=14, scale=2), nullable=True),
    sa.Column('bedrooms', sa.Numeric(precision=4, scale=1), nullable=True),
    sa.Column('bathrooms', sa.Numeric(precision=4, scale=1), nullable=True),
    sa.Column('square_feet', sa.Integer(), nullable=True),
    sa.Column('property_type', sa.String(length=30), nullable=True),
    sa.Column('distance_miles', sa.Numeric(precision=7, scale=3), nullable=True),
    sa.Column('days_old', sa.Integer(), nullable=True),
    sa.Column('similarity', sa.Numeric(precision=5, scale=4), nullable=True),
    sa.Column('listed_date', sa.Date(), nullable=True),
    sa.ForeignKeyConstraint(['rent_estimate_id'], ['rent_estimates.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id')
    )
    op.create_index(op.f('ix_rental_comparables_rent_estimate_id'), 'rental_comparables', ['rent_estimate_id'], unique=False)
    op.create_table('sale_comparables',
    sa.Column('id', sa.UUID(), nullable=False),
    sa.Column('value_estimate_id', sa.UUID(), nullable=False),
    sa.Column('formatted_address', sa.String(length=300), nullable=False),
    sa.Column('latitude', sa.Numeric(precision=9, scale=6), nullable=True),
    sa.Column('longitude', sa.Numeric(precision=9, scale=6), nullable=True),
    sa.Column('price', sa.Numeric(precision=14, scale=2), nullable=True),
    sa.Column('bedrooms', sa.Numeric(precision=4, scale=1), nullable=True),
    sa.Column('bathrooms', sa.Numeric(precision=4, scale=1), nullable=True),
    sa.Column('square_feet', sa.Integer(), nullable=True),
    sa.Column('property_type', sa.String(length=30), nullable=True),
    sa.Column('year_built', sa.Integer(), nullable=True),
    sa.Column('distance_miles', sa.Numeric(precision=7, scale=3), nullable=True),
    sa.Column('days_old', sa.Integer(), nullable=True),
    sa.Column('similarity', sa.Numeric(precision=5, scale=4), nullable=True),
    sa.Column('listed_date', sa.Date(), nullable=True),
    sa.ForeignKeyConstraint(['value_estimate_id'], ['value_estimates.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id')
    )
    op.create_index(op.f('ix_sale_comparables_value_estimate_id'), 'sale_comparables', ['value_estimate_id'], unique=False)


def downgrade() -> None:
    op.drop_index(op.f('ix_sale_comparables_value_estimate_id'), table_name='sale_comparables')
    op.drop_table('sale_comparables')
    op.drop_index(op.f('ix_rental_comparables_rent_estimate_id'), table_name='rental_comparables')
    op.drop_table('rental_comparables')
    op.drop_index(op.f('ix_property_listing_sources_listing_id'), table_name='property_listing_sources')
    op.drop_table('property_listing_sources')
    op.drop_index(op.f('ix_notifications_user_id'), table_name='notifications')
    op.drop_table('notifications')
    op.drop_index(op.f('ix_favorite_properties_user_id'), table_name='favorite_properties')
    op.drop_table('favorite_properties')
    op.drop_index(op.f('ix_watchlists_user_id'), table_name='watchlists')
    op.drop_table('watchlists')
    op.drop_index(op.f('ix_value_estimates_property_id'), table_name='value_estimates')
    op.drop_table('value_estimates')
    op.drop_table('user_preferences')
    op.drop_table('str_regulations')
    op.drop_index(op.f('ix_short_term_rental_estimates_property_id'), table_name='short_term_rental_estimates')
    op.drop_table('short_term_rental_estimates')
    op.drop_index(op.f('ix_saved_searches_user_id'), table_name='saved_searches')
    op.drop_table('saved_searches')
    op.drop_index(op.f('ix_rent_estimates_property_id'), table_name='rent_estimates')
    op.drop_table('rent_estimates')
    op.drop_index('ix_provider_api_usage_provider_created', table_name='provider_api_usage')
    op.drop_table('provider_api_usage')
    op.drop_index(op.f('ix_property_price_history_property_id'), table_name='property_price_history')
    op.drop_table('property_price_history')
    op.drop_index(op.f('ix_property_listings_status'), table_name='property_listings')
    op.drop_index(op.f('ix_property_listings_price'), table_name='property_listings')
    op.drop_table('property_listings')
    op.drop_index(op.f('ix_property_images_property_id'), table_name='property_images')
    op.drop_table('property_images')
    op.drop_index(op.f('ix_property_expenses_property_id'), table_name='property_expenses')
    op.drop_table('property_expenses')
    op.drop_index(op.f('ix_investment_analyses_user_id'), table_name='investment_analyses')
    op.drop_index(op.f('ix_investment_analyses_property_id'), table_name='investment_analyses')
    op.drop_table('investment_analyses')
    op.drop_index(op.f('ix_financing_scenarios_user_id'), table_name='financing_scenarios')
    op.drop_table('financing_scenarios')
    op.drop_index(op.f('ix_users_email'), table_name='users')
    op.drop_table('users')
    op.drop_table('providers')
    op.drop_index(op.f('ix_properties_zip_code'), table_name='properties')
    op.drop_index('ix_properties_state_city', table_name='properties')
    op.drop_geospatial_index('ix_properties_location', table_name='properties', postgresql_using='gist', column_name='location')
    op.drop_index(op.f('ix_properties_is_demo'), table_name='properties')
    op.drop_geospatial_table('properties')
    op.drop_index(op.f('ix_market_snapshots_zip_code'), table_name='market_snapshots')
    op.drop_table('market_snapshots')
