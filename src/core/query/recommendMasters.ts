/** Rank library masters for one intent. */
import type { GraphNode } from "@/core/model";
import { sameFamily, setOf } from "@/core/rules/family";
import { collapsedName, isNameInferredMaster } from "@/core/rules/names";
import { isRetired } from "@/core/rules/retired";
import { computeComponentUsage } from "./analytics";
import { bindRuleHit, type BindRulesFile, filterAndScoreByBindRules, fitBindRuleWarnings, packJourneyPhrase, preferDelta, whyLineForMaster } from "./bindRules";
import { fitEcho, shedEcho, shrinkNameFields } from "./cardFit";
import { angularText, useText } from "./codeMap";
import { BUILTIN_PROPERTY_HINTS, hintsFromFile, propertyBlock } from "./componentProperties";
import { withCost } from "./cost";
import { examplePointer } from "./examples";
import type { GraphIndex } from "./GraphIndex";
import { isWeakerNameStub, MASTER_TYPES, preferNamedMaster, realMastersNamed, RECOMMEND_BUDGET, sameNameNote, substitutionNote, variantCardName } from "./masterNames";
import { placeReady } from "./placeReady";
import { prepareAsk, purposeFallback, type MeaningDecision } from "./meaning/parse";
import { meaningDictionary } from "./meaning/buildDictionary";
import { interpretInflections, onlyInflectedAsk } from "./meaning/inflections";
import { GENERIC_NAME_TOKENS, navFamily, tokensOf } from "./queryTokens";
import { allSynonymGroups, appliedRecommendContext, contextTokenGroups, DEMOTE_UNASKED, deniedByRules, emitIconLibraryWarningsOnce, fromIconLibrary, iconLibraryWarnings, LABEL_FILLER, loadSynonymOverlay, mastersByScreen, screensOfMaster, variantHaystack } from "./recommendContext";
import { fixOneSlip, flagUncovered, hostFamilyName, searchDetail } from "./recommendDetail";
import { askGate, asksIcon, categoryHeadBonus, contextWords, distinctiveIconName, dropShadowedBaseTier, familyHaystack, finishRank, genericOnlyMiss, headTokenBonus, intentNamesMaster, isInternalPart, isPrivateMaster, isSetModifierVariant, LEXICAL_WEIGHT, lexicalScore, liveNameSets, looksLikeIcon, mastersToRank, matchHaystack, modifierWord, namesThisNode, nameTokenFor, normalizeAsk, partBeforeLink, phraseAliasBonus, phraseFamilyHit, phraseNamesMatch, repeatedSynonym, RETIRED_NAME_TOKENS, ruleNamesake, screenWords, setCoversAsk, shouldDemoteIcon, SLOT_QUALIFIERS, slotIsComponentRole, splitBrief, stripTier, synonymIn, tokenHits, tokenMatchesName, weakCheckWhy, weakMatchWhy, wholeNameTypo, withSynonymStopwords, xMeansClose } from "./recommendLexicon";
import { type RecommendAlternate, type RecommendCandidate, type RecommendContext, type RecommendHit, refreshHintFor, slotsForComponent, whereUsedRows } from "./recommendSupport";
import { codeMapView, liveReplacement, replacementOf } from "./replacements";
import { inflectionStems, overlap, similarUsage } from "./screenInventory";
import { usePropertyHints } from "./synonymLayer";
import { isRemovedByAbsence, patternFor, type SockState } from "./sock";
import { exampleQuery } from "./usageCard";
import { isLibraryFileKey, type WorkspaceManifest } from "./workspace";
import { nodeFileKey } from "./workspaceMerge";

/** Rank library masters for one intent. Context breaks ties. Never invents a component. */
export function recommendMasters(
  index: GraphIndex,
  intent: string,
  options: {
    budgetChars?: number;
    context?: RecommendContext;
    workspace?: WorkspaceManifest;
    sock?: SockState;
    bindRules?: BindRulesFile;
    placeholders?: string[];
    /** Plain token overlap, without the meaning parse. For the live-difference test. */
    lexicalOnly?: boolean;
    /** Skip purpose and word-form fallback. The regression gate uses this to see which leads those paths added. */
    skipFallback?: boolean;
  } = {},
) {
  loadSynonymOverlay();
  usePropertyHints([...BUILTIN_PROPERTY_HINTS, ...hintsFromFile(), ...(options.context?.propertyHints ?? [])]);
  const budgetChars = options.budgetChars ?? RECOMMEND_BUDGET;
  const echoIntent = intent.length > 200 ? `${intent.slice(0, 199)}…` : intent;
  const publicNameSets = liveNameSets(index);
  const dictionary = meaningDictionary(index);
  const catalogNames: string[] = [];
  for (const node of index.getNodesByType(...MASTER_TYPES)) {
    if (!node.name.startsWith(".") && !node.name.startsWith("_") && !node.name.includes("=")) catalogNames.push(node.name);
  }
  const slipped = normalizeAsk(fixOneSlip(intent, publicNameSets), catalogNames);
  const decision: MeaningDecision | undefined = options.lexicalOnly ? undefined : prepareAsk(slipped, dictionary);
  if (decision && onlyInflectedAsk(echoIntent, dictionary)) {
    decision.empty = true;
    delete decision.leadName;
  }
  const purpose = new Set(decision?.purposeTokens ?? []);
  intent = decision?.text ?? slipped;
  const analog = similarUsage(index, intent);
  const analogById = new Map(analog.variants.map((variant) => [variant.id, variant]));
  const slotRaw = options.context?.journey?.step?.trim() ?? "";
  const slotTokens = tokensOf(slotRaw.replace(/-/g, " "));
  const slotRole = slotIsComponentRole(slotTokens);
  const namesHit = (token: string) =>
    publicNameSets.some((names) => nameTokenFor(token, names, new Set()) !== undefined || synonymIn(token, names, false));
  const brief = splitBrief(partBeforeLink(intent, publicNameSets, false, screenWords(index)) ?? intent, namesHit);
  const roleWords = withSynonymStopwords(brief.role, tokensOf(brief.role));
  const reading = decision ? interpretInflections(roleWords, dictionary) : { tokens: roleWords, shared: [], attributes: [] };
  const sharedMiss = (name: string): string[] => {
    const lead = new Set(tokensOf(name));
    return reading.shared.filter((guess) => guess.part.every((word) => lead.has(word)) && !lead.has(guess.word)).map((guess) => guess.word);
  };
  const roleTokens = tokensOf(brief.role);
  const phraseExpanded = new Set<string>();
  const expandBlocked = new Set([
    "list", "table", "row", "rows", "item", "items", "card", "cards", "data",
    "top", "bottom", "left", "right", "header", "footer", "mobile", "desktop", "compact", "comfortable",
  ]);
  const askedSet = new Set(roleTokens);
  for (const group of allSynonymGroups()) {
    const said = group.terms.filter((term) => term.includes(" ") && tokensOf(term).every((token) => askedSet.has(token)));
    if (!said.length) continue;
    for (const term of group.terms) {
      if (said.includes(term)) continue;
      for (const token of tokensOf(term)) if (!expandBlocked.has(token)) phraseExpanded.add(token);
    }
  }
  const askedTokens = [...new Set([...reading.tokens, ...phraseExpanded])];
  if (xMeansClose(brief.role) && !askedTokens.includes("close")) askedTokens.push("close");
  // Exclusive family only when the slot is a component role and the intent is a
  // screen job ("sign in"). "input chip" and "checkout summary" already name a
  // master, so those tokens stay in the lexical score and context breaks the tie.
  const exclusiveSlot = slotRole && !intentNamesMaster(index, askedTokens);
  const familyTokens = slotTokens.filter((token) => !SLOT_QUALIFIERS.has(token));
  const tokens = exclusiveSlot
    ? familyTokens.length
      ? familyTokens
      : askedTokens
    : [...new Set([...askedTokens, ...(slotRole ? familyTokens : [])])];
  const extraTokens = exclusiveSlot ? askedTokens.filter((token) => !slotTokens.includes(token)) : [];
  const sceneTokens = exclusiveSlot
    ? [...new Set([...tokensOf(brief.scene), ...askedTokens])]
    : tokensOf(brief.scene);
  const placeTokens = [...new Set([...tokens, ...extraTokens, ...sceneTokens, ...slotTokens])];
  const nestedByScreen = mastersByScreen(index);
  const ctx = contextTokenGroups(options.context);
  const packRules = options.context?.libraryRules;
  const workspace = options.workspace;
  const libraryWarnings = iconLibraryWarnings(index, workspace);
  emitIconLibraryWarningsOnce(libraryWarnings);
  const graphFileKey = index.graph.fileKey;
  const bindQuery = {
    intent,
    domain: options.context?.domain,
    journey: options.context?.journey?.screenJob || options.context?.journey?.step,
    product: options.context?.product?.name || options.context?.product?.id,
    pack: options.context?.id,
    workspace,
    graphFileKey,
    sock: options.sock,
  };
  const bindRules = options.bindRules;
  const ruleBonus = bindRules?.rules.length
    ? (node: GraphNode) => preferDelta(bindRules, node, bindQuery)
    : undefined;
  const intentNeedle = intent.trim().toLowerCase();
  const allowClip = askedTokens.length >= 2;
  const componentWord = (token: string): boolean =>
    publicNameSets.some(
      (names) => nameTokenFor(token, names, new Set()) !== undefined || synonymIn(token, names, allowClip),
    );
  const synonymWord = (token: string): boolean =>
    publicNameSets.some((names) => synonymIn(token, names, allowClip));

  type Scored = {
    node: GraphNode;
    score: number;
    lexical: number;
    why: string[];
    whyOverride?: string;
    analog: boolean;
    deprecated: boolean;
    instances: number;
    setName?: string;
    exactName: boolean;
    covered: number;
    askCovered?: number;
    weak?: boolean;
    fallback?: "purpose" | "word-form";
  };

  const beforePurposeTail = tokens.filter((token) => !purpose.has(token));
  // "<part> list": the list word only groups the named part, so the part is the head ("chip list" is Chip).
  const headBase = beforePurposeTail.length ? beforePurposeTail : tokens;
  const placedIn = /^(.+?)\s+(?:in|inside|within|on)\s+(?:the\s+|a\s+|an\s+|my\s+|your\s+)?(?:[a-z]+\s+)*?(?:list|lists|group|set)\s*$/i.exec(intent.trim());
  const placedPart = placedIn ? tokensOf(placedIn[1]!).filter((token) => componentWord(token)) : [];
  const headTokens = placedPart.length ? placedPart :
    headBase.length >= 2 && ["list", "lists", "group", "set"].includes(headBase[headBase.length - 1]!) &&
    componentWord(headBase[headBase.length - 2]!) && !["list", "lists", "row", "rows", "item", "items"].includes(headBase[headBase.length - 2]!)
      ? headBase.slice(0, -1)
      : headBase;
  const scoreNode = (node: GraphNode, set: GraphNode | undefined): Scored | undefined => {
    const collapsedAsk = collapsedName(intentNeedle);
    const host = hostFamilyName(index, node, set);
    const familyLabel = familyHaystack(node, set, host);
    let exactName =
      Boolean(intentNeedle) &&
      (node.name.toLowerCase() === intentNeedle ||
        collapsedName(node.name) === collapsedAsk ||
        collapsedName(stripTier(node.name)) === collapsedAsk ||
        phraseNamesMatch(intentNeedle, node.name) ||
        phraseNamesMatch(intentNeedle, familyLabel) ||
        phraseFamilyHit(intentNeedle, familyLabel) ||
        (set !== undefined && collapsedName(stripTier(set.name)) === collapsedAsk) ||
        (Boolean(set) &&
          node.type === "COMPONENT_SET" &&
          (set!.name.toLowerCase() === intentNeedle ||
            collapsedName(set!.name) === collapsedAsk ||
            phraseNamesMatch(intentNeedle, set!.name))));
    const nameHaystack = familyLabel;
    const matched = matchHaystack(node, set);
    const detail = searchDetail(index, node, set);
    const hits = tokenHits(
      nameHaystack,
      `${matched.variant} ${detail.variant}`,
      tokens,
      allowClip,
      `${matched.describe} ${detail.describe}`,
    );
    const extraHits = extraTokens.length
      ? tokenHits(nameHaystack, matched.variant, extraTokens, allowClip, matched.describe)
      : undefined;
    let lexical: number;
    if (exactName) {
      lexical = lexicalScore(hits, true);
    } else if (exclusiveSlot) {
      if (hits.name === 0 && hits.synonym === 0 && hits.variant === 0) return undefined;
      const familyLexical = hits.name > 0 || hits.synonym > 0 ? LEXICAL_WEIGHT.name : LEXICAL_WEIGHT.variant;
      lexical =
        familyLexical +
        (extraHits?.name ?? 0) * LEXICAL_WEIGHT.name +
        (extraHits?.synonym ?? 0) * LEXICAL_WEIGHT.synonym +
        (extraHits?.variant ?? 0) * LEXICAL_WEIGHT.variant +
        (hits.describe + (extraHits?.describe ?? 0)) * LEXICAL_WEIGHT.describe;
    } else {
      lexical = lexicalScore(hits, false);
      const aliasBonus = phraseAliasBonus(intentNeedle, familyLabel);
      if (lexical === 0 && aliasBonus === 0) return undefined;
      lexical += aliasBonus;
      lexical += headTokenBonus(familyLabel, headTokens, allowClip, false) + categoryHeadBonus(familyLabel, tokens, allowClip);
      lexical += repeatedSynonym(familyLabel, tokens, allowClip) * 20;
      // Only a generic word before the tail ("picker for fruit") still needs the tail to fit.
      const missTokens = beforePurposeTail.length && !beforePurposeTail.every((token) => GENERIC_NAME_TOKENS.has(token)) ? beforePurposeTail : tokens;
      if (genericOnlyMiss(familyLabel, missTokens, allowClip, componentWord, synonymWord)) return undefined;
      const nameTokens = tokensOf(familyLabel);
      const matched = nameTokens.filter((token) => tokens.some((query) => tokenMatchesName(query, token))).length;
      const onlyContainer = headTokens !== headBase && nameTokens.every((token) => ["list", "lists", "group", "set"].includes(token));
      if (nameTokens.length > 0 && matched === nameTokens.length && !onlyContainer) lexical += 25;
      const asked = new Set([...tokens, ...extraTokens]);
      if (nameTokens.length > 1 && nameTokens.every((token) => asked.has(token))) lexical += 250;
      if (nameTokens.some((token) => DEMOTE_UNASKED.has(token) && !asked.has(token))) lexical -= 15;
      const askHas = (word: string) => asked.has(word);
      if (askHas("menu") && !askHas("dropdown") && !askHas("select") && nameTokens.includes("menu")) lexical += 40;
      if (askHas("row") && !askHas("list") && !askHas("table") && nameTokens.includes("row")) lexical += 70;
      if (askHas("badge") && nameTokens.includes("badge")) lexical += 40;
      if (
        !askHas("badge") &&
        ["warning", "notice", "announcement"].some((word) => askHas(word)) &&
        (nameTokens.includes("alert") || nameTokens.includes("banner"))
      ) lexical += 90;
      if (askHas("action") && nameTokens.includes("cta")) lexical += 70;
      if (askHas("button") && askHas("filled") && nameTokens.includes("button")) lexical += 50;
      if (askHas("button") && !askHas("floating") && !askHas("fab") && nameTokens.includes("fab")) lexical -= 60;
    }

    const analogHit = analogById.get(node.id);
    const screens = screensOfMaster(index, node);
    let whereUsedScore = 0;
    for (const screen of screens) whereUsedScore += overlap(screen.name, placeTokens);
    let coOccur = 0;
    for (const screen of screens) {
      for (const sibling of nestedByScreen.get(screen.id) ?? []) {
        if (sameFamily(node, sibling)) continue;
        const siblingSet = setOf(index, sibling);
        const haystack = `${sibling.name} ${siblingSet?.name ?? ""} ${variantHaystack(sibling)}`;
        coOccur += overlap(haystack, tokens);
      }
    }

    let productHit = 0;
    let clientHit = 0;
    let domainHit = 0;
    let journeyHit = 0;
    if (ctx) {
      for (const screen of screens) {
        productHit += overlap(screen.name, ctx.product);
        clientHit += overlap(screen.name, ctx.client);
        domainHit += overlap(screen.name, ctx.domain);
        journeyHit += overlap(screen.name, ctx.journey);
      }
    }
    const libraryHit = isLibraryFileKey(workspace, nodeFileKey(node, graphFileKey));
    const deprecated = isRetired(index, node);
    const instances = computeComponentUsage(index, node).instanceCount;
    const stale = instances === 0;
    const why: string[] = [];
    if (hits.name > 0 || (extraHits?.name ?? 0) > 0 || exactName) why.push("name");
    if (hits.synonym > 0 || (extraHits?.synonym ?? 0) > 0) why.push("synonym");
    if (hits.variant > 0 || (extraHits?.variant ?? 0) > 0) why.push("variant");
    if (hits.describe > 0 || (extraHits?.describe ?? 0) > 0) why.push("description");
    if (analogHit) why.push("similar-screen");
    if (whereUsedScore > 0) why.push("where-used");
    if (coOccur > 0) why.push("co-occur");
    if (productHit > 0) why.push("product");
    if (clientHit > 0) why.push("client");
    if (domainHit > 0) why.push("domain");
    if (journeyHit > 0) why.push("journey");
    if (libraryHit) why.push("library");
    if (instances > 0) why.push("usage");
    const sockPattern = options.sock ? patternFor(options.sock, node.id) : undefined;
    if (sockPattern?.promoted && sockPattern.confidence === "strong") why.push("sock-usage");
    if (stale) why.push("stale");

    const typeBoost = node.type === "COMPONENT_SET" ? 3 : node.type === "MAIN_COMPONENT" ? 2 : 1;
    const sockBoost = sockPattern?.promoted && sockPattern.confidence === "strong" ? 20 : 0;
    let context =
      Math.min(whereUsedScore, 4) * 40 +
      Math.min(coOccur, 4) * 8 +
      Math.min(productHit, 3) * 24 +
      Math.min(clientHit, 3) * 16 +
      Math.min(domainHit, 4) * 50 +
      Math.min(journeyHit, 4) * 50 +
      (analogHit ? 25 : 0) +
      (libraryHit ? 20 : 0) +
      sockBoost +
      (stale ? 0 : Math.min(36, Math.round(Math.log1p(instances) * 10))) +
      typeBoost;
    if (stale) context -= 30;
    if (slotRole) {
      const names = new Set(tokensOf(nameHaystack));
      const variants = new Set(tokensOf(matched.variant));
      for (const token of slotTokens) {
        if (!SLOT_QUALIFIERS.has(token)) continue;
        if (names.has(token) || variants.has(token)) context += 40;
      }
    }
    context = Math.max(0, Math.min(context, 999));
    let score = lexical * 1000 + context;
    if (deprecated) score -= 1_000_000;
    const iconLike = looksLikeIcon(index, node, set, workspace);
    const internal = isInternalPart(index, node);
    const askedExact =
      Boolean(intentNeedle) &&
      (node.name.toLowerCase() === intentNeedle ||
        (set && set.name.toLowerCase() === intentNeedle) ||
        collapsedName(node.name) === collapsedAsk);
    const nameHasIcon =
      tokensOf(node.name).includes("icon") || tokensOf(set?.name ?? "").includes("icon");
    if (shouldDemoteIcon(index, node, set, tokens, askedExact, workspace, intent)) score -= 500_000;
    if (asksIcon(tokens, intent) && !iconLike && !nameHasIcon && !askedExact) score -= 500_000;
    if (internal && !tokens.includes("base") && !askedExact) score -= 500_000;
    const askCovered = hits.covered + (extraHits?.covered ?? 0);
    const nameCoversAsk = setCoversAsk(intentNeedle, stripTier(host || set?.name || node.name));

    return {
      node,
      score,
      lexical,
      why,
      analog: Boolean(analogHit),
      deprecated,
      instances,
      setName: host && host !== node.name ? host : undefined,
      exactName,
      covered: askCovered,
      askCovered: hits.covered,
      weak:
        !exactName &&
        !nameCoversAsk &&
        hits.specific === 0 &&
        (extraHits?.specific ?? 0) === 0 &&
        (hits.name + hits.synonym + (extraHits?.name ?? 0) + (extraHits?.synonym ?? 0) > 0 ||
          hits.describe + (extraHits?.describe ?? 0) > 0),
    };
  };

  const scored: Scored[] = [];
  const retired: Scored[] = [];
  let privateCovered = 0;
  const toRank = mastersToRank(index, workspace, graphFileKey, intent);
  for (const node of toRank) {
    const set = setOf(index, node);
    if (deniedByRules(index, node, packRules)) continue;
    if (node.metadata?.["removedByAbsence"] === true) continue;
    if (isRemovedByAbsence(options.sock, node)) continue;
    const entry = scoreNode(node, set);
    if (!entry) continue;
    if (isPrivateMaster(index, node)) {
      privateCovered = Math.max(privateCovered, entry.covered);
      continue;
    }
    if (entry.deprecated) retired.push(entry);
    else scored.push(entry);
  }

  const publicCovered = scored.reduce((best, entry) => Math.max(best, entry.covered), 0);
  let blockedByPrivate = false;
  if (tokens.length > 0 && privateCovered > publicCovered) {
    scored.length = 0;
    retired.length = 0;
    blockedByPrivate = true;
  }

  const asksRetired =
    tokens.some((token) => RETIRED_NAME_TOKENS.has(token)) ||
    retired.some((entry) => entry.exactName);
  const askedSpecific = tokens.filter((token) => !RETIRED_NAME_TOKENS.has(token));
  let redirect: { id: string; reason: string; covered: number } | undefined;
  for (const entry of retired) {
    const replacement = liveReplacement(index, entry.node);
    if (!replacement) continue;
    const nameSpecific = tokensOf(entry.node.name).filter((token) => !RETIRED_NAME_TOKENS.has(token));
    const specificOverlap = askedSpecific.filter((token) => nameSpecific.includes(token)).length;
    // "legacy" alone may name a retired master. "legacy price" must not follow
    // Legacy Banner just because both names say legacy.
    if (askedSpecific.length > 0 && specificOverlap === 0) continue;
    const rank = askedSpecific.length > 0 ? specificOverlap : entry.covered;
    if (asksRetired && rank > 0 && entry.covered >= publicCovered) {
      const reason = `replaces ${setOf(index, entry.node)?.name ?? entry.node.name} (deprecated)`;
      if (!redirect || rank > redirect.covered) {
        redirect = { id: replacement.id, reason, covered: rank };
      }
    }
  }
  if (redirect) {
    const existing = scored.find((entry) => entry.node.id === redirect!.id);
    if (existing) {
      existing.whyOverride = redirect.reason;
      existing.score += 500_000;
    } else {
      const node = index.getNode(redirect.id);
      if (node && !isRetired(index, node) && !isPrivateMaster(index, node)) {
        const set = setOf(index, node);
        const injected = scoreNode(node, set) ?? {
          node,
          score: 0,
          lexical: 0,
          why: [] as string[],
          analog: false,
          deprecated: false,
          instances: computeComponentUsage(index, node).instanceCount,
          setName: set && set.id !== node.id ? set.name : undefined,
          exactName: false,
          covered: 0,
        };
        injected.whyOverride = redirect.reason;
        injected.score += 500_000;
        scored.push(injected);
      }
    }
  }

  const domainExempt = new Set<string>([...contextWords(options.context), ...screenWords(index)]);
  const gate = askGate(brief.role, askedTokens, publicNameSets, domainExempt, allowClip);
  if (gate.outOfDomain) {
    scored.length = 0;
    retired.length = 0;
  }
  const fillerPartial = askedTokens.some(
    (token) => LABEL_FILLER.has(token) || inflectionStems(token).some((stem) => LABEL_FILLER.has(stem)),
  );
  const lowConfidence = gate.lowConfidence || fillerPartial;

  if (!blockedByPrivate && scored.length === 0 && intentNeedle) {
    const winners: GraphNode[] = [];
    for (const node of index.getNodesByType(...MASTER_TYPES)) {
      if (isRetired(index, node) || isPrivateMaster(index, node)) continue;
      if (isNameInferredMaster(node)) continue;
      if (deniedByRules(index, node, packRules)) continue;
      if (node.metadata?.["removedByAbsence"] === true) continue;
      if (isRemovedByAbsence(options.sock, node)) continue;
      if (!wholeNameTypo(intentNeedle, node.name)) continue;
      winners.push(node);
    }
    const winner = winners.length === 1 ? winners[0] : undefined;
    if (winner) {
      const set = setOf(index, winner);
      scored.push({
        node: winner,
        score: 15_000,
        lexical: 15,
        why: ["typo"],
        analog: false,
        deprecated: false,
        instances: computeComponentUsage(index, winner).instanceCount,
        setName: set && set.id !== winner.id ? set.name : undefined,
        exactName: false,
        covered: 1,
      });
    }
  }

  const analogIds = new Set(analogById.keys());
  const analogSetIds = new Set(
    [...analogById.values()]
      .map((variant) => index.getNode(variant.id)?.componentSetId)
      .filter((id): id is string => Boolean(id)),
  );
  const setIds = new Set(
    scored.filter((entry) => entry.node.type === "COMPONENT_SET").map((entry) => entry.node.id),
  );
  let kept = scored.filter((entry) => {
    if (entry.node.type === "COMPONENT_SET" && analogSetIds.has(entry.node.id) && !entry.exactName) {
      return false;
    }
    if (entry.node.type !== "VARIANT") return true;
    if (entry.exactName || analogIds.has(entry.node.id)) return true;
    if (
      entry.why.includes("name") ||
      entry.why.includes("synonym") ||
      entry.why.includes("description") ||
      entry.why.includes("variant") ||
      entry.why.includes("typo") ||
      entry.why.includes("where-used") ||
      entry.why.includes("co-occur")
    ) {
      return true;
    }
    return !entry.node.componentSetId || !setIds.has(entry.node.componentSetId);
  });

  const byMasterRank = (a: Scored, b: Scored) =>
    Number(b.exactName) - Number(a.exactName) ||
    (a.exactName && b.exactName ? b.covered - a.covered : 0) ||
    b.score - a.score ||
    Number(a.deprecated) - Number(b.deprecated) ||
    a.node.name.localeCompare(b.node.name);
  kept.sort(byMasterRank);

  if (options.bindRules?.rules.length) {
    kept = filterAndScoreByBindRules(kept, options.bindRules, {
      ...bindQuery,
      index,
      inject: (node) => {
        const set = setOf(index, node);
        return {
          node,
          score: 1_000_000,
          lexical: 1_000,
          why: ["bind-rule"],
          analog: false,
          deprecated: isRetired(index, node),
          instances: computeComponentUsage(index, node).instanceCount,
          setName: set && set.id !== node.id ? set.name : undefined,
          exactName: false,
          covered: tokens.length,
        };
      },
    });
    kept.sort(byMasterRank);
  }

  kept = finishRank(
    kept.filter((entry) => !isNameInferredMaster(entry.node)),
    tokens,
    allowClip,
    purpose,
    componentWord,
  );
  // A variant value is not a component once a real name already matched.
  const grounded = (entry: Scored): boolean =>
    entry.exactName ||
    Boolean(entry.whyOverride) ||
    entry.why.includes("name") ||
    entry.why.includes("synonym") ||
    entry.why.includes("description") ||
    entry.why.includes("typo") ||
    entry.why.includes("bind-rule");
  const variantWordOnly =
    askedTokens.length > 0 && askedTokens.every((token) => modifierWord(token));
  const hasGrounded = kept.some(grounded);
  kept = kept.filter((entry) => {
    if (grounded(entry)) return true;
    if (hasGrounded || !variantWordOnly) return false;
    return entry.why.includes("variant");
  });

  const familyKeyOf = (entry: Scored): string => setOf(index, entry.node)?.id ?? entry.node.id;
  const asFamilyRow = (entry: Scored): Scored => {
    const set = setOf(index, entry.node);
    if (!set || set.id === entry.node.id) return entry;
    const namesSet = namesThisNode(intentNeedle, set, index);
    const propertyOnly = isSetModifierVariant(entry.node, set);
    if (namesThisNode(intentNeedle, entry.node, index) || !propertyOnly) {
      return {
        ...entry,
        weak: namesSet ? false : entry.weak,
      };
    }
    if (entry.analog && !namesSet) {
      return {
        ...entry,
        weak: namesSet ? false : entry.weak,
      };
    }
    return {
      ...entry,
      node: set,
      setName: undefined,
      instances: computeComponentUsage(index, set).instanceCount,
      deprecated: isRetired(index, set),
      exactName: entry.exactName || namesSet,
      weak: namesSet ? false : entry.weak,
    };
  };
  const collapsed: Scored[] = [];
  const seenFamily = new Set<string>();
  for (const entry of kept) {
    const key = familyKeyOf(entry);
    if (seenFamily.has(key)) continue;
    seenFamily.add(key);
    collapsed.push(asFamilyRow(entry));
  }
  flagUncovered(collapsed, intentNeedle, tokens, (entry) => stripTier(entry.setName || setOf(index, entry.node)?.name || entry.node.name), componentWord, purpose);
  const navAsk = /(?:^| )(?:nav|navigation)(?: bar)?$/.test(tokens.join(" "));
  kept = collapsed.filter((entry) => {
    if (navAsk && !entry.exactName && !navFamily(tokensOf(stripTier(entry.setName || entry.node.name)), tokens)) return false;
    const namesakes = realMastersNamed(index, entry.node.name);
    const preferred = preferNamedMaster(index, namesakes, workspace, intent, ruleBonus);
    if (!preferred || preferred.id === entry.node.id) return true;
    return !isWeakerNameStub(index, entry.node, preferred);
  });
  if (decision?.empty) kept = kept.filter((entry) => entry.why.includes("typo"));
  const loneWord = tokensOf(echoIntent).length === 1 ? tokensOf(echoIntent)[0] : undefined;
  const stemNamesPart = Boolean(
    loneWord &&
      /(?:ed|ing)$/.test(loneWord) &&
      inflectionStems(loneWord).some((stem) =>
        dictionary.entries.some((entry) => !entry.retired && (entry.nameTokens.includes(stem) || entry.synonyms.includes(stem))),
      ),
  );
  if (!options.skipFallback && !stemNamesPart && kept.length === 0 && decision && !decision.empty && !decision.leadName && !onlyInflectedAsk(echoIntent, dictionary)) {
    const liveEntries = dictionary.entries.filter((entry) => !entry.retired);
    const purposeHit = purposeFallback(tokensOf(echoIntent), liveEntries);
    const node = purposeHit ? realMastersNamed(index, purposeHit.name).find((item) => !isRetired(index, item) && !isPrivateMaster(index, item)) : undefined;
    if (node) {
      kept = [{
        node,
        score: 800_000,
        lexical: 800,
        why: ["name"],
        analog: false,
        deprecated: false,
        instances: computeComponentUsage(index, node).instanceCount,
        exactName: false,
        covered: tokens.length,
        weak: true,
        fallback: "purpose",
      }];
    }
  }
  const loneInflected = Boolean(loneWord && /(?:ed|ing)$/.test(loneWord));
  const listedSynonym = Boolean(loneWord && dictionary.synonymGroups.some((group) => group.includes(loneWord)));
  if (loneInflected && !listedSynonym && kept[0] && !kept[0].why.some((item) => item === "name" || item === "synonym" || item === "typo")) kept = [];
  if (kept.length > 1) {
    const leadName = kept[0]!.node.name;
    const same = kept.filter((entry) => entry.node.name === leadName);
    if (same.length > 1) {
      const preferred = preferNamedMaster(
        index,
        same.map((entry) => entry.node),
        workspace,
        intent,
        ruleBonus,
      );
      const chosen = preferred ? same.find((entry) => entry.node.id === preferred.id) : undefined;
      if (chosen) kept = [chosen, ...kept.filter((entry) => entry.node.id !== preferred!.id)];
    }
  }

  const askedBase = askedTokens.includes("base") || intentNeedle.startsWith("base/");
  const askedIcon = asksIcon(askedTokens, intent);
  const demotedPart = (entry: Scored): boolean => {
    const set = setOf(index, entry.node);
    const askedExact =
      entry.node.name.toLowerCase() === intentNeedle ||
      Boolean(set && set.name.toLowerCase() === intentNeedle);
    if (fromIconLibrary(index, entry.node, workspace) && !askedIcon) {
      if (askedExact && distinctiveIconName(entry.node.name)) return false;
      if (askedExact && set && distinctiveIconName(set.name)) return false;
      return true;
    }
    if (namesThisNode(intentNeedle, entry.node, index)) return false;
    if (set && namesThisNode(intentNeedle, set, index)) return false;
    if (isInternalPart(index, entry.node) && !askedBase && !askedExact) return true;
    return shouldDemoteIcon(index, entry.node, set, askedTokens, askedExact, workspace, intent);
  };
  if (kept.some((entry) => !demotedPart(entry))) {
    kept = kept.filter((entry) => !demotedPart(entry));
  }
  kept = dropShadowedBaseTier(kept, askedBase, (entry) => setOf(index, entry.node)?.name ?? entry.node.name);

  // A retired part stays mapped and flagged, and is never the pick to place.
  const view = codeMapView(index);
  let retiredNote: string | undefined;
  let onlyRetired: { name: string; use?: string; guess?: boolean } | undefined;
  const retiredNow = (entry: Scored) =>
    entry.deprecated || isRetired(index, entry.node) || Boolean(view?.retired(entry.node));
  const gone = kept.filter(retiredNow);
  kept = kept.filter((entry) => !retiredNow(entry));
  const best = [...gone, ...retired].sort(
    (a, b) => Number(b.exactName) - Number(a.exactName) || b.covered - a.covered,
  )[0];
  if (best && (best.exactName || (view && best.covered > Math.max(0, ...kept.map((entry) => entry.covered))))) {
    const name = setOf(index, best.node)?.name ?? best.node.name;
    const found = replacementOf(index, best.node, view?.twin ?? (() => undefined));
    const useNode = found?.node;
    const use = useNode?.name;
    retiredNote = `${name} is retired${use ? `, ${useText(use, found?.guess)}` : ""}.`;
    if (useNode && best.exactName) {
      const existing = kept.find((entry) => entry.node.id === useNode.id);
      if (existing) existing.whyOverride = `replaces ${name} (deprecated)`;
      const lead: Scored = existing ?? {
        node: useNode,
        score: 1_000_000,
        lexical: 1_000,
        why: ["name"],
        whyOverride: `replaces ${name} (deprecated)`,
        analog: false,
        deprecated: false,
        instances: computeComponentUsage(index, useNode).instanceCount,
        exactName: false,
        covered: best.covered,
      };
      kept = [lead, ...kept.filter((entry) => entry.node.id !== useNode.id)];
    }
    if (!kept.length) onlyRetired = { name, use, guess: found?.guess };
  }

  // Same rule as resolve: a live master whose name matches the ask (letter case ignored)
  // is the top pick, ahead of a similar name that only shares collapsed letters.
  // A listed icon still loses a generic ask ("search" → Search field, not the Search icon).
  const exactLive = realMastersNamed(index, intent.trim()).filter((node) => {
    if (isPrivateMaster(index, node) || isRetired(index, node) || view?.retired(node)) return false;
    const set = setOf(index, node);
    const askedExact =
      node.name.toLowerCase() === intentNeedle ||
      variantCardName(index, node).trim().toLowerCase() === intentNeedle ||
      Boolean(set && set.name.toLowerCase() === intentNeedle);
    return !shouldDemoteIcon(index, node, set, askedTokens, askedExact, workspace, intent);
  });
  const literalPick = preferNamedMaster(index, exactLive, workspace, intent.trim(), ruleBonus);
  const exactPick = literalPick && ruleNamesake(literalPick, kept.map((entry) => entry.node), ruleBonus);
  if (exactPick) {
    const existing = kept.find((entry) => entry.node.id === exactPick.id);
    const lead: Scored = existing
      ? { ...existing, exactName: true, weak: false }
      : {
          node: exactPick,
          score: 1_000_000,
          lexical: 1_000,
          why: ["name"],
          analog: false,
          deprecated: false,
          instances: computeComponentUsage(index, exactPick).instanceCount,
          exactName: true,
          covered: tokens.length,
        };
    kept = [lead, ...kept.filter((entry) => entry.node.id !== exactPick.id)];
  }

  const familyCardName = (entry: Scored): string => {
    if (entry.setName && entry.node.name.includes("=") && !namesThisNode(intentNeedle, entry.node, index)) return entry.setName;
    if (entry.node.type !== "VARIANT") return variantCardName(index, entry.node);
    const set = setOf(index, entry.node);
    if (!isSetModifierVariant(entry.node, set)) return variantCardName(index, entry.node);
    if (namesThisNode(intentNeedle, entry.node, index)) return variantCardName(index, entry.node);
    return set?.name ?? variantCardName(index, entry.node);
  };

  if (decision && !decision.empty) {
    const banned = new Set(decision.excluded.map((name) => name.toLowerCase()));
    while (kept[0] && banned.has(familyCardName(kept[0]).toLowerCase())) kept.shift();
    if (decision.leadName && !kept[0]?.exactName) {
      const wanted = decision.leadName.toLowerCase();
      const idx = kept.findIndex((entry) => familyCardName(entry).toLowerCase() === wanted || entry.node.name.toLowerCase() === wanted);
      if (idx > 0) {
        const [hit] = kept.splice(idx, 1);
        if (hit) {
          if (decision.reasons.some((reason) => reason.startsWith("A breadcrumb") || reason.startsWith("No density variant") || reason.startsWith("The named part"))) hit.weak = false;
          kept.unshift(hit);
        }
      } else if (idx === 0 && kept[0] && decision.reasons.some((reason) => reason.startsWith("A breadcrumb") || reason.startsWith("No density variant") || reason.startsWith("The named part"))) {
        kept[0].weak = false;
      } else if (idx < 0) {
        const node = realMastersNamed(index, decision.leadName).find((item) => !isRetired(index, item) && !isPrivateMaster(index, item));
        if (node) {
          const set = setOf(index, node);
          kept.unshift({
            node: set && set.id !== node.id ? set : node,
            score: 900_000,
            lexical: 900,
            why: ["name"],
            analog: false,
            deprecated: false,
            instances: computeComponentUsage(index, node).instanceCount,
            exactName: false,
            covered: tokens.length,
            weak: decision.weakWords.length > 0 && !decision.reasons.some((reason) => reason.startsWith("No density variant") || reason.startsWith("The named part")),
          });
        }
      }
    }
    if (decision.secondName && kept.length) {
      const wanted = decision.secondName.toLowerCase();
      const at = kept.findIndex((entry) => familyCardName(entry).toLowerCase() === wanted || entry.node.name.toLowerCase() === wanted);
      if (at > 1) {
        const [hit] = kept.splice(at, 1);
        if (hit) kept.splice(1, 0, hit);
      } else if (at < 0) {
        const node = realMastersNamed(index, decision.secondName).find((item) => !isRetired(index, item) && !isPrivateMaster(index, item));
        if (node) {
          const set = setOf(index, node);
          kept.splice(1, 0, {
            node: set && set.id !== node.id ? set : node,
            score: 700_000,
            lexical: 700,
            why: ["name"],
            analog: false,
            deprecated: false,
            instances: computeComponentUsage(index, node).instanceCount,
            exactName: false,
            covered: tokens.length,
            weak: false,
          });
        }
      }
    }
  }
  if (kept[0] && !kept[0].fallback) {
    const leadLabel = familyCardName(kept[0]).toLowerCase();
    const asked = new Set(tokensOf(echoIntent));
    const says = (part: string) => [...asked].some((token) => token === part || token === `${part}s` || token === `${part}es`);
    const strongAlias = allSynonymGroups().some((group) => {
      const namesLead = group.terms.some((term) => term.toLowerCase() === leadLabel);
      if (!namesLead) return false;
      return group.terms.some((term) => term.includes(" ") && tokensOf(term).every((part) => says(part)));
    });
    if (strongAlias) kept[0].weak = false;
  }

  const settingsOf = (node: GraphNode): string | undefined => {
    const set = node.type === "COMPONENT_SET" ? node : node.componentSetId ? index.getNode(node.componentSetId) : undefined;
    const variants = set ? index.getVariantsOf(set.id) : [];
    if (!variants.length) return undefined;
    const props: string[] = [];
    const seen = new Set<string>();
    for (const variant of variants) {
      for (const key of Object.keys(variant.variantProperties ?? {})) {
        if (seen.has(key)) continue;
        seen.add(key);
        props.push(key);
      }
    }
    const names = props.slice(0, 4).join(", ");
    return names ? `${variants.length} variants · ${names}` : `${variants.length} variants`;
  };

  const packJourney = packJourneyPhrase(options.context);

  const toCandidate = (
    entry: Scored,
    includeSlots: boolean,
    whereLimit: number,
  ): RecommendCandidate => {
    const whereUsed = whereUsedRows(index, entry.node, whereLimit);
    const slots = includeSlots ? slotsForComponent(index, entry.node) : [];
    const place = placeReady(entry.node, graphFileKey);
    const hint = entry.deprecated
      ? "Deprecated — do not place."
      : place.published
        ? "Place fileKey + nodeId + componentKey."
        : "Place fileKey + nodeId. Local-only (no published key).";
    const why =
      entry.whyOverride ??
      whyLineForMaster(entry.node, {
        sock: options.sock,
        packJourney,
        bindRule: options.bindRules
          ? bindRuleHit(options.bindRules, entry.node, bindQuery)
          : undefined,
        graphFileKey,
        instances: entry.instances,
      });
    return {
      id: entry.node.id,
      name: familyCardName(entry),
      type: entry.node.type,
      ...place,
      variantProperties: entry.node.variantProperties,
      ...(settingsOf(entry.node) ? { settings: settingsOf(entry.node) } : {}),
      set: entry.setName,
      status: entry.node.status,
      deprecated: entry.deprecated,
      instances: entry.instances,
      whereUsed,
      ...(slots.length ? { slots } : {}),
      score: entry.score,
      why,
      hint,
    };
  };

  const tight = budgetChars <= RECOMMEND_BUDGET;
  const target = tight ? 3 : 6;
  let limit = Math.min(kept.length, target);
  let truncated = kept.length > limit;
  let dropExtras = false;
  let dropVariant = false;
  let shedPlaceNoise = false;
  let shedLeadDetail = false;
  let omitExNote = false;
  /** `all` keeps the catalog. `matched` keeps rows the request named, before hits 2–3 go. `none` goes before the lead's why. */
  let propertyKeep: "all" | "matched" | "none" = "all";
  const exQuery = exampleQuery(index, options);

  const shortReason = (why: string): string => {
    const cut = why.split(";")[0]?.trim() || why;
    return cut.length > 64 ? `${cut.slice(0, 61)}…` : cut;
  };

  const leadCandidate = (entry: Scored, top: boolean): RecommendCandidate => {
    const full = toCandidate(entry, false, 0);
    if (entry === kept[0] && sharedMiss(familyCardName(entry)).length > 0) {
      full.why = `Weak, check: ${sharedMiss(familyCardName(entry)).map((word) => `"${word}"`).join(", ")} not in ${familyCardName(entry)}.`;
    } else if (
      entry.weak &&
      entry === kept[0] &&
      /used \d+× in file/.test(full.why) &&
      !/bind rule|used on \d+ real screen/.test(full.why)
    ) {
      full.why = weakMatchWhy(intent, familyCardName(entry));
    }
    const pointer = examplePointer(index, entry.node, exQuery, tight ? "id" : "screen");
    const block = top
      ? propertyBlock(index, entry.node, intent, view?.twin(entry.node)?.angular, options.context?.propertyHints)
      : undefined;
    const keptRows = !block || propertyKeep === "none"
      ? []
      : propertyKeep === "matched"
        ? block.properties.filter((row) => row.designerSays)
        : block.properties;
    const next: RecommendCandidate = {
      ...full,
      ...(keptRows.length
        ? {
            properties: keptRows,
            ...(block?.apply && keptRows.some((row) => row.designerSays) ? { apply: block.apply } : {}),
          }
        : {}),
      whereUsed: [],
      ...pointer,
      hint: full.deprecated ? "Deprecated — do not place." : "Place fileKey + nodeId.",
    };
    if (omitExNote) delete next.exNote;
    if (top && shedPlaceNoise) {
      const loose = next as unknown as Record<string, unknown>;
      delete loose["score"];
      if (loose["nodeId"] === loose["figmaNodeId"]) delete loose["nodeId"];
      delete loose["whereUsed"];
      delete loose["publishState"];
      if (typeof next.why === "string" && next.why.length > 48) next.why = `${next.why.slice(0, 47)}…`;
    }
    if (lowConfidence && !shedLeadDetail) next.confidence = "low";
    // The why line stays: find.md and --help promise it on the top hit.
    if (top && shedLeadDetail) {
      const loose = next as unknown as Record<string, unknown>;
      delete loose["confidence"];
      delete loose["componentKey"];
      delete loose["published"];
      delete loose["publishState"];
      delete loose["instances"];
      delete loose["hint"];
      if (loose["deprecated"] === false) delete loose["deprecated"];
    }
    delete next.slots;
    if (dropExtras) {
      delete next.set;
      delete next.settings;
    }
    if (dropVariant) {
      delete next.variantProperties;
    }
    return next;
  };

  const altCandidate = (entry: Scored): RecommendAlternate => {
    const place = placeReady(entry.node, graphFileKey);
    const why = entry.whyOverride ?? toCandidate(entry, false, 0).why;
    return {
      id: entry.node.id,
      name: familyCardName(entry),
      why: shortReason(why),
      ...(place.fileKey ? { fileKey: place.fileKey } : {}),
      ...(place.figmaNodeId ? { figmaNodeId: place.figmaNodeId } : {}),
    };
  };

  const listed = (): RecommendHit[] =>
    kept.slice(0, limit).map((entry, position) =>
      position === 0 || !tight ? leadCandidate(entry, position === 0) : altCandidate(entry),
    );

  let candidates = listed();

  const applied = appliedRecommendContext(options.context);
  let contextEcho = applied ? { ...applied } : undefined;
  const echoBag: { hint?: string } = {};
  const leadNode = kept[0]?.node;
  const leadSetName = leadNode
    ? setOf(index, leadNode)?.name ?? leadNode.name
    : "";
  const leadSetCovers = leadSetName ? setCoversAsk(intentNeedle, leadSetName) : false;
  const leadCovered = kept[0]?.covered ?? 0;
  const leadNameTokens = kept[0] ? tokensOf(familyCardName(kept[0])) : [];
  const bannerMismatch = tokens.includes("banner") && !leadNameTokens.includes("banner");
  // A lead reached only through a shared noun after an -ed/-ing word ("dated item") is a guess: weak, like compose.
  // An empty answer is never weak: weak means there is a lead to check.
  const weakLead = kept[0] !== undefined && (
    Boolean(kept[0].fallback) ||
    sharedMiss(familyCardName(kept[0])).length > 0 ||
    bannerMismatch ||
    (Boolean(kept[0].weak) && !kept[0].exactName && !(leadSetCovers && leadCovered >= tokens.length)));
  const leadClashes = leadNode ? realMastersNamed(index, leadNode.name) : [];
  const clashNote = leadNode ? sameNameNote(index, leadClashes, leadNode) : undefined;
  const subNote = substitutionNote(index, intent, leadNode);
  const extraNote = [clashNote, subNote].filter(Boolean).join(" ") || undefined;
  const payloadOf = () => {
    if (weakLead && candidates[0]) Object.assign(candidates[0], { why: weakCheckWhy((candidates[0] as { why?: string }).why, sharedMiss(kept[0] ? familyCardName(kept[0]) : ""), intent, candidates[0].name) });
    const base = {
      intent: echoIntent,
      candidates,
      truncated,
      ...(weakLead ? { match: "weak match" } : {}),
      ...(extraNote ? { note: extraNote } : {}),
      ...(contextEcho && Object.keys(contextEcho).length ? { context: contextEcho } : {}),
      ...(options.context?.warning ? { warning: options.context.warning } : {}),
      hint:
        echoBag.hint ??
        (weakLead
          ? "Weak match. Do not Read graph.json."
          : candidates.length === 0
            ? `No master matched. Do not invent. ${refreshHintFor(options.sock, graphFileKey)}`
            : candidates.length > 1 &&
                candidates.slice(1).some((row) => !("fileKey" in row && row.fileKey) || !("figmaNodeId" in row && row.figmaNodeId))
              ? `Place fileKey+nodeId on the top hit. Resolve an alternate by id before placing it. ${refreshHintFor(options.sock, graphFileKey)}`
              : `Place fileKey+nodeId. ${refreshHintFor(options.sock, graphFileKey)}`),
    };
    const fitted = fitBindRuleWarnings(options.bindRules?.warnings, base, budgetChars);
    return { ...base, ...fitted };
  };

  let payload = payloadOf();
  if (JSON.stringify(payload).length > budgetChars) {
    shedEcho(contextEcho, () => JSON.stringify(payloadOf()).length > budgetChars);
    payload = payloadOf();
  }
  const shrink = () => {
    candidates = listed();
    payload = payloadOf();
  };

  if (JSON.stringify(payload).length > budgetChars && candidates[0] && "exNote" in candidates[0]) {
    omitExNote = true;
    shrink();
  }
  const overBudget = () => JSON.stringify(payload).length > budgetChars;
  if (overBudget()) {
    const lead = candidates[0];
    if (lead && "properties" in lead && Array.isArray(lead.properties) && lead.properties.length) {
      shedPlaceNoise = true;
      shrink();
    }
  }
  if (overBudget()) {
    dropExtras = true;
    shrink();
  }
  if (overBudget()) {
    dropVariant = true;
    shrink();
  }
  if (overBudget()) {
    const lead = candidates[0];
    if (lead && "why" in lead && lead.why.length > 48) {
      lead.why = `${lead.why.slice(0, 47)}…`;
      payload = payloadOf();
    }
  }
  if (overBudget() && contextEcho) {
    const journey = contextEcho["journey"];
    if (typeof journey === "string" && journey.length > 80) {
      delete contextEcho["journey"];
      delete contextEcho["journeyFrom"];
      payload = payloadOf();
    }
    const optional = ["a11y", "a11yFrom", "audience", "audienceFrom", "files", "client", "clientFrom", "domainFrom", "productFrom", "warning"] as const;
    for (const key of optional) {
      if (!overBudget()) break;
      delete contextEcho[key];
      payload = payloadOf();
    }
  }
  if (overBudget() && candidates[0] && "properties" in candidates[0]) {
    propertyKeep = "matched";
    shrink();
  }
  if (overBudget()) {
    const ceiling = Math.min(kept.length, target);
    const counts = [...new Set([ceiling, Math.min(2, ceiling), 1])].filter((count) => count >= 1);
    const plans = [
      ...counts.map((count) => ({ count, variants: true })),
      ...counts.map((count) => ({ count, variants: false })),
    ];
    for (const plan of plans) {
      limit = plan.count;
      dropVariant = !plan.variants;
      truncated = kept.length > plan.count;
      shrink();
      fitEcho(payload, contextEcho, echoBag, budgetChars);
      payload = payloadOf();
      if (!overBudget()) break;
      const lead = candidates[0];
      if (lead && "why" in lead && lead.why.length > 72) {
        lead.why = `${lead.why.slice(0, 69)}…`;
        payload = payloadOf();
        if (!overBudget()) break;
      }
    }
  }
  const warningsWanted = options.bindRules?.warnings?.length ?? 0;
  const warningMissing = () =>
    warningsWanted > 0 && !payload.bindRuleWarnings?.length && !payload.warningNote;
  fitEcho(payload, contextEcho, echoBag, budgetChars);
  payload = payloadOf();
  if (warningMissing() || JSON.stringify(payload).length > budgetChars) {
    fitEcho(payload, contextEcho, echoBag, budgetChars);
    payload = payloadOf();
  }
  while (warningMissing() && candidates.length > 1) {
    truncated = true;
    limit = candidates.length - 1;
    shrink();
    fitEcho(payload, contextEcho, echoBag, budgetChars);
    payload = payloadOf();
  }
  if (JSON.stringify(payload).length > budgetChars) {
    fitEcho(payload, contextEcho, echoBag, budgetChars, true);
    payload = payloadOf();
  }
  if (JSON.stringify(payload).length > budgetChars) {
    const lead = candidates[0];
    if (lead && "whereUsed" in lead && Array.isArray(lead.whereUsed) && lead.whereUsed.length === 0) {
      delete lead.whereUsed;
    }
    if (contextEcho && "files" in contextEcho) delete contextEcho["files"];
    payload = payloadOf();
  }
  if (JSON.stringify(payload).length > budgetChars) {
    shrinkNameFields(payload, budgetChars);
  }
  if (JSON.stringify(payload).length > budgetChars) {
    const lead = payload.candidates?.[0];
    if (lead && "why" in lead && typeof lead.why === "string" && lead.why.length > 48) {
      lead.why = `${lead.why.slice(0, 47)}…`;
    }
    echoBag.hint = "Place fileKey + nodeId.";
    payload = payloadOf();
    if (JSON.stringify(payload).length > budgetChars) shrinkNameFields(payload, budgetChars);
  }
  if (overBudget() && candidates[0] && "properties" in candidates[0]) {
    shedLeadDetail = true;
    shrink();
  }
  if (overBudget() && candidates[0] && "properties" in candidates[0]) {
    propertyKeep = "none";
    shrink();
  }

  const lead = kept[0];
  const leadTwin = lead && !weakLead && !lead.deprecated ? view?.twin(lead.node) : undefined;
  const codeLine = leadTwin && !leadTwin.retired ? leadTwin.line : undefined;
  const ngLine = codeLine ? leadTwin?.angular : undefined;
  if (
    codeLine &&
    candidates[0] &&
    "properties" in candidates[0] &&
    JSON.stringify({ ...payload, code: codeLine, ...(ngLine ? { angular: angularText(ngLine) } : {}) }).length > budgetChars
  ) {
    shedPlaceNoise = true;
    dropExtras = true;
    shrink();
  }
  const extra: { retired?: string; code?: string; angular?: string } = {};
  const append = <K extends keyof typeof extra>(key: K, value?: (typeof extra)[K]) => {
    if (value && JSON.stringify({ ...payload, ...extra, [key]: value }).length <= budgetChars) extra[key] = value;
  };
  const only = onlyRetired ? { ...payload, hint: `Only match is retired: ${onlyRetired.name}. ${onlyRetired.guess ? "Closest current part (guess): " : "Use "}${onlyRetired.use ?? "none"}.` } : undefined;
  const said = only && JSON.stringify(only).length <= budgetChars;
  if (!said) append("retired", retiredNote);
  append("code", leadTwin && !leadTwin.retired ? leadTwin.line : undefined);
  // Selector and module as one short line (inputs and outputs are on the resolve card), only beside a code line.
  const ng = extra.code ? leadTwin?.angular : undefined;
  append("angular", ng ? angularText(ng) : undefined);

  return withCost({ ...(said ? only : payload), ...extra });
}
