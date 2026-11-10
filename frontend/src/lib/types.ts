// Friendly aliases over the types generated from the backend OpenAPI schema.
// Regenerate with:  npm run gen:api   (see package.json)
import type { components } from "./api-types";

type S = components["schemas"];

export type SystemStatus = S["SystemStatus"];
export type Meta = S["Meta"];
export type SearchFilters = S["SearchFilters-Input"];
export type SearchJob = S["SearchJob"];
export type SearchResults = S["SearchResults"];
export type PropertyCard = S["PropertyCard"];
export type StrategySummary = S["StrategySummary"];
export type MapPoint = S["MapPoint"];
export type MapResults = S["MapResults"];
export type Badge = S["Badge"];
export type NLParseResult = S["NLParseResult"];
export type PropertyDetail = S["PropertyDetail"];
export type PropertyContext = S["PropertyContext"];
export type PropertyAnalysis = S["PropertyAnalysis"];
export type StrategyResult = S["StrategyResult"];
export type Assumptions = S["Assumptions"];
export type AssumptionOverrides = S["AssumptionsOverrides-Input"];
export type ScoreWeights = S["ScoreWeights-Input"];
export type QualityAssessment = S["QualityAssessment"];
export type InvestmentScore = S["InvestmentScore"];
export type ForecastResult = S["ForecastResult"];
export type ScenarioResult = S["ScenarioResult"];
export type SensitivityResult = S["SensitivityResult"];
export type FinancingScenarioResult = S["FinancingScenarioResult"];
export type RentEstimate = S["RentEstimateOut"];
export type ValueEstimate = S["ValueEstimateOut"];
export type StrEstimate = S["StrEstimateOut"];
export type Comparable = S["ComparableOut"];
export type AIExplanationResponse = S["AIExplanationResponse"];
export type CompareResponse = S["CompareResponse"];
export type CompareMetric = S["CompareMetric"];
export type MarketSummary = S["MarketSummary"];
export type ZipMarket = S["ZipMarket"];
export type SessionOut = S["SessionOut"];
export type User = S["UserOut"];
export type Preferences = S["Preferences-Input"];
export type SavedSearch = S["SavedSearchOut"];
export type Favorite = S["FavoriteOut"];
export type Watchlist = S["WatchlistOut"];
export type SavedAnalysis = S["SavedAnalysisOut"];
export type NotificationList = S["NotificationList"];
export type UsageReport = S["UsageReport"];
export type ProviderUsage = S["ProviderUsage"];
export type Regulation = S["RegulationOut"];
export type FinancingPreset = S["FinancingOut"];
export type LegalityInfo = S["LegalityInfo"];

export type Strategy = "ltr" | "str";
export type StrategyFilter = "ltr" | "str" | "both";
export type SortKey = SearchResults["sort"];
export type Provenance = "verified" | "estimated" | "default" | "user" | "unavailable";
export type Confidence = "high" | "medium" | "low" | "insufficient";
export type AssumptionSection = keyof AssumptionOverrides;
