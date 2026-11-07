/**
 * Agent-facing graph surface. Graph stays on disk.
 * Recommend, resolve, verify, and the cards around them live in sibling modules.
 * This file re-exports the public API.
 */
export { EXACT_COMPONENT_HINT, LAYER_NAME_GUESS } from "./cardCopy";
export { type AgentCost, costOf, withCost } from "./cost";
export { masterPopulation, otherNamedMasters, placeableMasterByName, preferNamedMaster, variantCardName } from "./masterNames";
export { resolveNode, resolveNodeExact } from "./nodeLookup";
export { type OrientBrief, buildOrientBrief, checkFrame, explainNode, pathBetween, queryQuestion, suggestQuestions, toGraphReportMarkdown } from "./orient";
export { iconLibraryWarnings } from "../recommend/recommendContext";
export { masterLooksLikeIcon } from "../recommend/recommendLexicon";
export { recommendMasters } from "../recommend/recommendMasters";
export { type LibraryRules, type RecommendAlternate, type RecommendCandidate, type RecommendContext, type RecommendHit, parseLibraryRules } from "../recommend/recommendSupport";
export { codeMapCard, codeMapRows, codeMapView, ingredientCard, ingredientCoverage, retiredHooks, screenPartsCard } from "../recommend/replacements";
export { screenInventory, sharedComponents, similarUsage } from "./screenInventory";
export { usageCardForComponent } from "../recommend/usageCard";
export { componentUsageCard, exampleCard } from "../recommend/usageResolve";
export { type UnresolvedReason, type VerifyHit, type VerifyReason, type VerifyResolved, verifyFrame } from "../verify/verifyFrame";
export { isNameInferredMaster, isPrivateMasterName } from "@/core/rules/names";
