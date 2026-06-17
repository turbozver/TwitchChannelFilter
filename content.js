const STORAGE_KEY = "twitchChannelFilterSettings";

const DEFAULT_SETTINGS = {
    enabled: true,
    channelAllowlist: [],
    channelBlocklist: [],
    categoryMode: "off",
    categoryBlocklist: [],
    categoryAllowlist: [],
    channelRules: []
};

let settings = { ...DEFAULT_SETTINGS };
let filterScheduled = false;
let expandTimer = null;
let expandCheckTimer = null;
let mainRescanTimer = null;
let mainRescanUntil = 0;
let lastRoute = getRouteKey();

const runtime = typeof chrome !== "undefined" ? chrome : browser;
const SECTION_EXPAND_LIMITS = [
    { pattern: "followed channels", minVisibleLive: 8 },
    { pattern: "live channels", minVisibleLive: 4 },
    { pattern: "viewers also watch", minVisibleLive: 2 }
];

function normalize(value) {
    return String(value || "")
        .trim()
        .toLowerCase()
        .replace(/^@+/, "");
}

function normalizeCategory(value) {
    return String(value || "")
        .trim()
        .toLowerCase()
        .replace(/\s+/g, " ");
}

function normalizeSettings(raw) {
    const merged = { ...DEFAULT_SETTINGS, ...(raw || {}) };
    const legacyCategoryList = normalizeList(merged.categoryList, normalizeCategory);
    const categoryBlocklist = normalizeList(merged.categoryBlocklist, normalizeCategory);
    const categoryAllowlist = normalizeList(merged.categoryAllowlist, normalizeCategory);

    return {
        enabled: Boolean(merged.enabled),
        channelAllowlist: normalizeList(merged.channelAllowlist, normalize),
        channelBlocklist: normalizeList(merged.channelBlocklist, normalize),
        categoryMode: ["off", "block", "allow"].includes(merged.categoryMode) ? merged.categoryMode : "off",
        categoryBlocklist: categoryBlocklist.length ? categoryBlocklist : (merged.categoryMode === "block" ? legacyCategoryList : []),
        categoryAllowlist: categoryAllowlist.length ? categoryAllowlist : (merged.categoryMode === "allow" ? legacyCategoryList : []),
        channelRules: normalizeChannelRules(merged.channelRules)
    };
}

function normalizeChannelRules(value) {
    if (!Array.isArray(value)) return [];

    return value.flatMap((rule, index) => {
        const channel = normalize(rule.channel);
        const mode = rule.mode === "allow" ? "allow" : "block";
        const createdAt = Number(rule.createdAt) || Date.now() - index;
        const categories = rule.category
            ? [normalizeCategory(rule.category)]
            : normalizeList(rule.categories, normalizeCategory);

        return categories
            .filter(Boolean)
            .map((category, categoryIndex) => ({
                channel,
                mode,
                category,
                createdAt: createdAt - categoryIndex
            }));
    }).filter((rule) => rule.channel && rule.category);
}

function normalizeList(value, normalizer) {
    const source = Array.isArray(value) ? value : String(value || "").split(/\r?\n|,/);
    return [...new Set(source.map(normalizer).filter(Boolean))];
}

function getFromStorage(keys) {
    return new Promise((resolve) => runtime.storage.sync.get(keys, resolve));
}

async function loadSettings() {
    const result = await getFromStorage([STORAGE_KEY]);
    settings = normalizeSettings(result[STORAGE_KEY]);
    scheduleFilterBurst({ allowExpand: true });
}

function scheduleFilter(options = {}) {
    if (filterScheduled) return;

    filterScheduled = true;
    window.requestAnimationFrame(() => {
        filterScheduled = false;
        applyFilters(options);
    });
}

function scheduleFilterBurst(options = {}, { restartMainRescan = false } = {}) {
    const delays = [0, 100, 350, 800, 1500, 3000];

    for (const delay of delays) {
        window.setTimeout(() => scheduleFilter(options), delay);
    }

    scheduleMainContentRescan(10000, { restart: restartMainRescan });
}

function applyFilters({ allowExpand = false } = {}) {
    const cards = collectChannelCards();
    let hiddenStateChanged = false;

    for (const card of cards) {
        const info = getCardInfo(card);
        const hidden = settings.enabled && shouldHide(info, {
            ignoreGlobalCategoryRules: shouldIgnoreGlobalCategoryRules(card)
        });
        const wasHidden = card.dataset.tcfHidden === "true";

        setCardHidden(card, hidden);
        card.dataset.tcfHidden = hidden ? "true" : "false";
        hiddenStateChanged = hiddenStateChanged || hidden !== wasHidden;

        if (hidden) {
            card.dataset.tcfHiddenReason = getHideReason(info);
        } else {
            delete card.dataset.tcfHiddenReason;
        }
    }

    if (allowExpand || hiddenStateChanged) {
        scheduleExpandCheck();
    }
}

function setCardHidden(card, hidden) {
    clearNestedHiddenState(card);
    card.classList.toggle("tcf-hidden-channel", hidden);

    if (hidden) {
        if (!card.dataset.tcfPreviousDisplay && card.style.display) {
            card.dataset.tcfPreviousDisplay = card.style.display;
        }
        card.style.setProperty("display", "none", "important");
        return;
    }

    if (card.dataset.tcfPreviousDisplay) {
        card.style.display = card.dataset.tcfPreviousDisplay;
        delete card.dataset.tcfPreviousDisplay;
        return;
    }

    card.style.removeProperty("display");
}

function clearNestedHiddenState(card) {
    const nested = card.querySelectorAll(".tcf-hidden-channel, [data-tcf-hidden], [data-tcf-previous-display]");

    for (const element of nested) {
        element.classList.remove("tcf-hidden-channel");
        delete element.dataset.tcfHidden;
        delete element.dataset.tcfHiddenReason;

        if (element.dataset.tcfPreviousDisplay) {
            element.style.display = element.dataset.tcfPreviousDisplay;
            delete element.dataset.tcfPreviousDisplay;
        } else if (element.style.display === "none") {
            element.style.removeProperty("display");
        }
    }
}

function scheduleMainContentRescan(duration = 10000, { restart = false } = {}) {
    if (restart && mainRescanTimer) {
        window.clearTimeout(mainRescanTimer);
        mainRescanTimer = null;
    }

    if (mainRescanTimer) return;

    mainRescanUntil = Date.now() + duration;

    const tick = () => {
        mainRescanTimer = null;
        scheduleFilter();

        if (Date.now() >= mainRescanUntil) return;
        mainRescanTimer = window.setTimeout(tick, 500);
    };

    mainRescanTimer = window.setTimeout(tick, 500);
}

function getRouteKey() {
    return `${location.pathname}${location.search}`;
}

function handleRouteChange() {
    const route = getRouteKey();
    if (route === lastRoute) return;

    lastRoute = route;
    scheduleFilterBurst({ allowExpand: true }, { restartMainRescan: true });
}

function installRouteWatchers() {
    for (const method of ["pushState", "replaceState"]) {
        const original = history[method];
        if (typeof original !== "function") continue;

        history[method] = function (...args) {
            const result = original.apply(this, args);
            window.setTimeout(handleRouteChange, 0);
            return result;
        };
    }

    window.addEventListener("popstate", handleRouteChange);
    window.addEventListener("hashchange", () => scheduleFilterBurst({ allowExpand: true }));
    window.addEventListener("pageshow", () => scheduleFilterBurst({ allowExpand: true }));
    window.addEventListener("load", () => scheduleFilterBurst({ allowExpand: true }));
    document.addEventListener("visibilitychange", () => {
        if (!document.hidden) scheduleFilterBurst({ allowExpand: true });
    });

    window.setInterval(handleRouteChange, 500);
}

function scheduleExpandCheck() {
    window.clearTimeout(expandCheckTimer);

    expandCheckTimer = window.setTimeout(() => {
        expandCheckTimer = null;
        maybeExpandSideNav();
    }, 250);
}

function collectChannelCards() {
    const cards = new Set();
    const scopes = findSideNavScopes();

    for (const scope of scopes) {
        const scopeIsFallback = scope === document;
        const directCandidates = [
            ...scope.querySelectorAll([
                ".side-nav-card",
                '[data-test-selector="followed-channel"]',
                '[data-test-selector="recommended-channel"]',
                '[data-a-id^="followed-channel-"]',
                '[data-a-id^="recommended-channel-"]'
            ].join(","))
        ];

        for (const candidate of directCandidates) {
            const card = candidate.matches("a") ? findChannelCard(candidate) : candidate;
            card.dataset.tcfArea = "sidebar";
            const info = getCardInfo(card);
            if (!info.channel) continue;
            cards.add(card);
        }

        if (scopeIsFallback) continue;

        const links = [...scope.querySelectorAll('a[href^="/"], a[href^="https://www.twitch.tv/"]')];

        for (const link of links) {
            const channel = getChannelFromHref(link.href);
            if (!channel) continue;

            const card = findChannelCard(link);
            if (!card) continue;
            card.dataset.tcfArea = "sidebar";
            cards.add(card);
        }
    }

    for (const card of collectMainContentChannelCards()) {
        card.dataset.tcfArea = "main";
        cards.add(card);
    }

    return [...cards];
}

function collectMainContentChannelCards() {
    const cards = new Set();

    for (const scope of findMainContentScopes()) {
        const links = [...scope.querySelectorAll([
            'a[data-a-target="preview-card-channel-link"][href]',
            'a.preview-card-channel-link[href]',
            'a[data-a-target="preview-card-image-link"][href]',
            'a.preview-card-image-link[href]',
            'a[data-test-selector="TitleAndChannel"][href]',
            '[data-test-selector="shelf-card-selector"] a[href]',
            '[data-target][style*="order"] a[href]',
            'article[data-ffz-type="live"] a[href]'
        ].join(","))];

        for (const link of links) {
            if (isInsideSideNav(link)) {
                continue;
            }

            const channel = getChannelFromHref(link.href);
            if (!channel) continue;

            const card = findMainContentCard(link);
            if (!card || isInsideSideNav(card)) {
                continue;
            }
            card.dataset.tcfArea = "main";

            const info = getCardInfo(card);
            if (!info.channel || !isMainContentCard(card)) {
                continue;
            }
            cards.add(card);
        }
    }

    return [...cards];
}

function findMainContentScopes() {
    const scopes = [...document.querySelectorAll([
        'main',
        '[role="main"]',
        '[data-a-target="main-content"]',
        '#root'
    ].join(","))].filter((scope) => (
        scope.querySelector('[data-a-target="preview-card-channel-link"], .preview-card-channel-link, [data-test-selector="TitleAndChannel"], article[data-ffz-type="live"]')
    ));

    return scopes.length ? [...new Set(scopes)] : [document];
}

function isMainContentCard(card) {
    return Boolean(card.querySelector([
        '[data-a-target="preview-card-channel-link"]',
        '.preview-card-channel-link',
        '[data-a-target="preview-card-image-link"]',
        '.preview-card-image-link',
        '[data-test-selector="TitleAndChannel"]'
    ].join(",")) || card.matches([
        'article[data-ffz-type="live"]',
        '[data-test-selector="shelf-card-selector"]',
        '[data-target][style*="order"]',
        '[data-target="directory-first-item"]',
        '[data-target="directory-item"]',
        '[data-target^="directory-item-"]',
        ".tw-col"
    ].join(",")));
}

function isInsideSideNav(element) {
    return Boolean(element.closest([
        '[data-a-target="side-nav-bar"]',
        '[data-test-selector="side-nav"]',
        '#side-nav',
        '.side-nav',
        '.side-nav-section',
        '.side-nav-card',
        '[data-test-selector="followed-channel"]',
        '[data-test-selector="recommended-channel"]'
    ].join(",")));
}

function findMainContentCard(link) {
    const stableCard = link.closest([
        ".tw-col",
        '[data-target][style*="order"]',
        '[data-target="directory-first-item"]',
        '[data-target="directory-item"]',
        '[data-target^="directory-item-"]',
        '[data-test-selector="shelf-card-selector"]',
        'article[data-ffz-type="live"]'
    ].join(","));

    if (stableCard && !isInsideSideNav(stableCard)) {
        return promoteMainContentCard(stableCard);
    }

    let node = link;
    for (let depth = 0; node && depth < 8; depth += 1, node = node.parentElement) {
        if (!node.parentElement) break;

        const hasPreviewLink = Boolean(node.querySelector('[data-a-target="preview-card-channel-link"], .preview-card-channel-link'));
        const hasImageLink = Boolean(node.querySelector('[data-a-target="preview-card-image-link"], .preview-card-image-link'));
        const text = getVisibleText(node);

        if (hasPreviewLink && hasImageLink && text.length > 0 && text.length < 1200) {
            return promoteMainContentCard(node);
        }
    }

    return promoteMainContentCard(link);
}

function promoteMainContentCard(card) {
    let promoted = card;
    let node = card;

    for (let depth = 0; node && node.parentElement && depth < 8; depth += 1, node = node.parentElement) {
        if (isMainContentBoundary(node)) break;
        if (isInsideSideNav(node)) break;

        if (isMainGridItem(node)) {
            promoted = node;
            continue;
        }

        if (node !== card && isLikelyRepeatedMainItem(node)) {
            promoted = node;
        }
    }

    return promoted;
}

function isMainGridItem(element) {
    return element.matches([
        ".tw-col",
        '[data-target][style*="order"]',
        '[data-target="directory-first-item"]',
        '[data-target="directory-item"]',
        '[data-target^="directory-item-"]',
        '[data-test-selector="shelf-card-selector"]'
    ].join(","));
}

function isLikelyRepeatedMainItem(element) {
    if (!element.parentElement) return false;

    const parent = element.parentElement;
    const siblings = [...parent.children].filter((child) => (
        child !== element &&
        child.nodeType === Node.ELEMENT_NODE &&
        hasMainPreviewCard(child)
    ));

    if (!siblings.length) return false;
    if (!hasMainPreviewCard(element)) return false;
    if (element.querySelectorAll('[data-a-target="preview-card-channel-link"], .preview-card-channel-link, [data-test-selector="TitleAndChannel"]').length > 1) return false;

    const text = getVisibleText(element);
    return text.length > 0 && text.length < 1600;
}

function hasMainPreviewCard(element) {
    return Boolean(element.querySelector([
        '[data-a-target="preview-card-channel-link"]',
        '.preview-card-channel-link',
        '[data-a-target="preview-card-image-link"]',
        '.preview-card-image-link',
        '[data-test-selector="TitleAndChannel"]',
        'article[data-ffz-type="live"]'
    ].join(",")));
}

function isMainContentBoundary(element) {
    if (!element || element === document.body || element.id === "root") return true;
    return element.matches([
        "main",
        '[role="main"]',
        '[data-a-target="main-content"]',
        '[data-test-selector="directory-page__content"]'
    ].join(","));
}

function findSideNavScopes() {
    const selectors = [
        '[data-a-target="side-nav-bar"]',
        '[data-test-selector="side-nav"]',
        "#side-nav",
        ".side-nav",
        'nav[aria-label*="followed" i]',
        'nav[aria-label*="recommended" i]',
        'nav[aria-label*="channels" i]',
        'nav[aria-label*="left" i]',
        'aside[aria-label*="followed" i]',
        'aside[aria-label*="recommended" i]',
        'aside[aria-label*="channels" i]',
        'aside[aria-label*="left" i]'
    ];

    const scopes = [...new Set(selectors.flatMap((selector) => [...document.querySelectorAll(selector)]))]
        .filter((scope) => scope.querySelector(".side-nav-card, [data-test-selector='followed-channel'], [data-test-selector='recommended-channel'], a[href]"));

    return scopes;
}

function getChannelFromHref(href) {
    try {
        const url = new URL(href, location.origin);
        if (url.hostname !== "www.twitch.tv" && url.hostname !== "twitch.tv") return "";

        const parts = url.pathname.split("/").filter(Boolean);
        if (parts.length !== 1) return "";

        const channel = normalize(parts[0]);
        const reserved = new Set([
            "directory",
            "downloads",
            "friends",
            "inventory",
            "jobs",
            "p",
            "popout",
            "settings",
            "store",
            "subscriptions",
            "turbo",
            "wallet"
        ]);

        return reserved.has(channel) ? "" : channel;
    } catch {
        return "";
    }
}

function findChannelCard(link) {
    const stableCard = link.closest([
        '[data-a-target*="side-nav-card"]',
        '[data-test-selector*="side-nav-card"]',
        ".side-nav-card",
        '[data-a-target*="channel-card"]',
        '[data-test-selector*="channel-card"]'
    ].join(","));

    if (stableCard) return stableCard;

    let node = link;
    for (let depth = 0; node && depth < 8; depth += 1, node = node.parentElement) {
        if (!node.parentElement) break;

        const text = getVisibleText(node);
        const linkCount = node.querySelectorAll('a[href^="/"], a[href^="https://www.twitch.tv/"]').length;
        const hasAvatar = Boolean(node.querySelector("img, figure, [data-a-target*='avatar']"));

        if (hasAvatar && linkCount <= 3 && text.length > 0 && text.length < 260) {
            return node;
        }
    }

    return link;
}

function getCardInfo(card) {
    const links = card.matches?.('a[href^="/"], a[href^="https://www.twitch.tv/"]')
        ? [card, ...card.querySelectorAll('a[href^="/"], a[href^="https://www.twitch.tv/"]')]
        : [...card.querySelectorAll('a[href^="/"], a[href^="https://www.twitch.tv/"]')];

    const channelLink = links
        .map((link) => ({ link, channel: getChannelFromHref(link.href) }))
        .find((item) => item.channel);

    const isMainCard = card.dataset.tcfArea === "main";
    const cachedChannel = card.dataset.tcfChannel || "";
    const channel = channelLink?.channel || (isMainCard ? "" : cachedChannel);
    if (channelLink?.channel && channelLink.channel !== cachedChannel) {
        delete card.dataset.tcfCategory;
    }
    if (isMainCard && !channelLink?.channel) {
        delete card.dataset.tcfChannel;
        delete card.dataset.tcfCategory;
    }

    const displayName = channelLink?.link.textContent?.trim() || channel;
    const inferredCategory = inferMainContentCategory(card);
    const extractedCategory = inferredCategory || extractCategory(card, channel, displayName);
    const category = extractedCategory || card.dataset.tcfCategory || "";

    if (channel) {
        card.dataset.tcfChannel = channel;
    }

    if (extractedCategory) {
        card.dataset.tcfCategory = extractedCategory;
    }

    return { card, channel, displayName, category };
}

function extractCategory(card, channel, displayName) {
    const targetSelectors = [
        '[data-a-target*="game-title"]',
        '[data-a-target*="category"]',
        '[data-test-selector*="game-title"]',
        '[data-test-selector*="category"]',
        'a[href^="/directory/category/"]'
    ];

    for (const selector of targetSelectors) {
        const element = card.querySelector(selector);
        const text = element?.textContent?.trim();
        if (text && !isIgnoredCategoryLine(text, channel, displayName)) return text;
    }

    const metadataSelectors = [
        '[data-a-target="side-nav-card-metadata"] [class*="side-nav-card__metadata"] [title]',
        '[data-a-target="side-nav-card-metadata"] [class*="side-nav-card__metadata"] p',
        '[class*="side-nav-card__metadata"] [title]',
        '[class*="side-nav-card__metadata"] p'
    ];

    for (const selector of metadataSelectors) {
        const element = card.querySelector(selector);
        const text = (element?.getAttribute("title") || element?.textContent || "").trim();
        if (text && !isIgnoredCategoryLine(text, channel, displayName)) return text;
    }

    const lines = getVisibleText(card)
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);

    const ignored = new Set([
        channel,
        displayName,
        "live",
        "offline",
        "recommended channels",
        "followed channels",
        "viewers",
        "viewer"
    ].map(normalizeCategory));

    for (const line of lines) {
        const normalizedLine = normalizeCategory(line);
        if (ignored.has(normalizedLine)) continue;
        if (isIgnoredCategoryLine(line, channel, displayName)) continue;
        if (/^\d+([.,]\d+)?[kк]?\s+(viewers?|зрителей|глядачів)$/i.test(line)) continue;
        if (line.length > 60) continue;

        return line;
    }

    return "";
}

function isIgnoredCategoryLine(line, channel, displayName) {
    const ignored = new Set([
        channel,
        displayName,
        "live",
        "offline",
        "recommended channels",
        "followed channels",
        "viewers",
        "viewer"
    ].map(normalizeCategory));

    const normalizedLine = normalizeCategory(line);
    if (ignored.has(normalizedLine)) return true;
    if (/^\+\d+$/.test(line)) return true;
    if (/\band\s+\d+\s+guests?\b/i.test(line)) return true;
    if (/^\d+([.,]\d+)?[kк]?\s+(viewers?|зрителей|глядачів)$/i.test(line)) return true;
    if (line.length > 60) return true;

    return false;
}

function inferMainContentCategory(card) {
    if (!isDirectoryCategoryPage()) return "";
    if (card.dataset.tcfArea && card.dataset.tcfArea !== "main") return "";
    if (!card.querySelector('[data-a-target="preview-card-channel-link"], .preview-card-channel-link')) return "";

    const heading = document.querySelector("#directory-game-main-content h1, h1");
    const text = heading?.textContent?.trim();
    if (text && !isIgnoredCategoryLine(text, "", "")) return text;

    const title = document.title.replace(/\s*-\s*Twitch\s*$/i, "").trim();
    return title && normalizeCategory(title) !== "twitch" ? title : "";
}

function getVisibleText(element) {
    return (element.innerText || element.textContent || "").replace(/\u00a0/g, " ").trim();
}

function shouldIgnoreGlobalCategoryRules(card) {
    return card.dataset.tcfArea === "main" && isDirectoryCategoryPage();
}

function isDirectoryCategoryPage() {
    return location.pathname.split("/").filter(Boolean).slice(0, 2).join("/") === "directory/category";
}

function shouldHide(info, { ignoreGlobalCategoryRules = false } = {}) {
    if (!info.channel) return false;

    if (settings.channelAllowlist.includes(info.channel)) return false;
    if (settings.channelBlocklist.includes(info.channel)) return true;

    const category = normalizeCategory(info.category);
    const channelRules = settings.channelRules.filter((rule) => rule.channel === info.channel);

    if (channelRules.length) {
        const blockMatched = channelRules.some((rule) => rule.mode === "block" && matchesCategoryList(category, [rule.category]));
        if (blockMatched) return true;

        const allowRules = channelRules.filter((rule) => rule.mode === "allow");
        if (allowRules.length) {
            return !allowRules.some((rule) => matchesCategoryList(category, [rule.category]));
        }

        return false;
    }

    if (ignoreGlobalCategoryRules) return false;

    if (settings.categoryMode === "block") {
        return Boolean(category && matchesCategoryList(category, settings.categoryBlocklist));
    }

    if (settings.categoryMode === "allow") {
        if (!settings.categoryAllowlist.length) return false;
        return Boolean(category && !matchesCategoryList(category, settings.categoryAllowlist));
    }

    return false;
}

function matchesCategoryList(category, list) {
    const normalizedCategory = normalizeCategory(category);
    if (!normalizedCategory || !list.length) return false;

    return list.some((item) => {
        const normalizedItem = normalizeCategory(item);
        return normalizedItem && normalizedCategory.includes(normalizedItem);
    });
}

function maybeExpandSideNav() {
    if (!settings.enabled) {
        return;
    }

    if (expandTimer) {
        return;
    }

    const button = findExpandableShowMoreButton();
    if (!button) {
        return;
    }

    expandTimer = window.setTimeout(() => {
        expandTimer = null;
        clickShowMoreButton(button);
        scheduleFilter();
        window.setTimeout(scheduleExpandCheck, 600);
    }, 120);
}

function findExpandableShowMoreButton() {
    const buttons = findAllShowMoreButtons();

    for (const button of buttons) {
        const section = findShowMoreSection(button);
        if (!section) {
            continue;
        }

        const config = getSectionExpandConfig(section);
        if (!config) {
            continue;
        }

        const cards = collectSectionChannelCards(section);
        const visibleCards = cards.filter((card) => !isFilteredCard(card) && isRenderedCard(card));
        const visibleLiveCards = visibleCards.filter(isLiveCard);

        if (visibleLiveCards.length >= config.minVisibleLive) {
            continue;
        }

        if (visibleCards.length && isOfflineCard(visibleCards[visibleCards.length - 1])) {
            continue;
        }

        return button;
    }

    return null;
}

function findAllShowMoreButtons() {
    const scopes = [...findSideNavScopes().filter((scope) => scope !== document), document];
    const buttons = scopes.flatMap((scope) => [
        ...scope.querySelectorAll("button, [role='button'], a[data-a-target*='show-more' i], a[data-test-selector*='show-more' i]")
    ]);

    return [...new Set(buttons)].filter((button) => (
        isClickableShowMore(button) &&
        (hasShowMoreMarker(button) || isStrictShowMoreText(button))
    ));
}

function findShowMoreSection(button) {
    return button.closest('[role="group"][aria-label], [aria-label].side-nav-section, [class*="side-nav-section"]');
}

function clickShowMoreButton(button) {
    button.click();
    for (const type of ["mousedown", "mouseup", "click"]) {
        button.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
    }
}

function findExpandableSection() {
    for (const section of findSideNavSections()) {
        const config = getSectionExpandConfig(section);
        if (!config) continue;

        const cards = collectSectionChannelCards(section);
        const visibleCards = cards.filter((card) => !isFilteredCard(card));
        const visibleLiveCards = visibleCards.filter(isLiveCard);

        if (visibleLiveCards.length >= config.minVisibleLive) continue;
        if (visibleCards.length && isOfflineCard(visibleCards[visibleCards.length - 1])) continue;
        if (!findShowMoreButtonCandidate(section)) continue;

        return { section, config };
    }

    return null;
}

function findSideNavSections() {
    const scopes = findSideNavScopes().filter((scope) => scope !== document);
    const sections = scopes.flatMap((scope) => [
        ...scope.querySelectorAll('[role="group"][aria-label], [aria-label].side-nav-section, [class*="side-nav-section"][aria-label]')
    ]);

    return [...new Set(sections)];
}

function getSectionExpandConfig(section) {
    const label = getSectionLabel(section);
    return SECTION_EXPAND_LIMITS.find((config) => label.includes(config.pattern)) || null;
}

function getSectionLabel(section) {
    const ariaLabel = section.getAttribute("aria-label") || "";
    const headingText = [...section.querySelectorAll("h2, h3")]
        .map((heading) => heading.textContent)
        .find(Boolean) || "";

    return normalizeCategory(`${ariaLabel} ${headingText}`);
}

function collectSectionChannelCards(section) {
    const seenChannels = new Set();

    return [
        ...section.querySelectorAll([
            ".side-nav-card",
            '[data-test-selector="followed-channel"]',
            '[data-test-selector="recommended-channel"]',
            '[data-a-id^="followed-channel-"]',
            '[data-a-id^="recommended-channel-"]'
        ].join(","))
    ]
        .map((candidate) => candidate.matches("a") ? findChannelCard(candidate) : candidate)
        .filter((card) => {
            if (!card) return false;
            const channel = getCardInfo(card).channel;
            if (!channel || seenChannels.has(channel)) return false;
            seenChannels.add(channel);
            return true;
        });
}

function isFilteredCard(card) {
    return card.classList.contains("tcf-hidden-channel") || card.dataset.tcfHidden === "true";
}

function isRenderedCard(card) {
    if (!card.isConnected) return false;

    const style = window.getComputedStyle(card);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;

    const rect = card.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
}

function isLiveCard(card) {
    const info = getCardInfo(card);
    return Boolean(info.channel && getLiveStatusElement(card) && !isOfflineCard(card));
}

function isOfflineCard(card) {
    if (!getLiveStatusElement(card)) return true;

    const text = `\n${normalizeCategory(getVisibleText(card))}\n`;
    return text.includes("\noffline\n") || text.includes("\nnot live\n");
}

function getLiveStatusElement(card) {
    return card.querySelector('[data-a-target="side-nav-live-status"], [class*="side-nav-card__live-status"]');
}

function findShowMoreButton() {
    const scopes = findSideNavScopes().filter((scope) => scope !== document);
    const selector = [
        'button[data-a-target*="show-more" i]',
        'button[data-test-selector*="show-more" i]',
        'button[aria-label*="show more" i]',
        'button[aria-label*="show-more" i]'
    ].join(",");

    for (const scope of scopes) {
        const stableButton = scope.querySelector(selector);
        if (stableButton && !stableButton.disabled) return stableButton;

        const textButton = [...scope.querySelectorAll("button")]
            .find((button) => {
                if (button.disabled) return false;
                const text = normalizeCategory(button.textContent);
                return text === "show more" || text === "показать больше" || text === "показати більше";
            });

        if (textButton) return textButton;
    }

    return null;
}

function findShowMoreButtonCandidate(section = null) {
    const scopes = section
        ? [section]
        : [...findSideNavScopes().filter((scope) => scope !== document), document];
    const selector = [
        '[data-a-target*="side-nav-show-more" i]',
        'button[data-a-target*="show-more" i]',
        '[role="button"][data-a-target*="show-more" i]',
        'a[data-a-target*="show-more" i]',
        'button[data-test-selector*="show-more" i]',
        '[role="button"][data-test-selector*="show-more" i]',
        'button[aria-label*="show more" i]',
        '[role="button"][aria-label*="show more" i]',
        'button[aria-label*="show-more" i]',
        '[role="button"][aria-label*="show-more" i]'
    ].join(",");

    for (const scope of scopes) {
        const stableButton = [...scope.querySelectorAll(selector)].find(isClickableShowMore);
        if (stableButton) return stableButton;

        const textButton = [...scope.querySelectorAll("button, [role='button'], a")]
            .find((button) => isClickableShowMore(button) && isShowMoreText(button));

        if (textButton) return textButton;
    }

    return null;
}

function isClickableShowMore(element) {
    if (!element || element.disabled) return false;
    if (element.getAttribute("aria-disabled") === "true") return false;
    if (element.closest("[hidden], [aria-hidden='true']")) return false;

    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
}

function isShowMoreText(element) {
    const text = normalizeCategory(element.textContent || element.getAttribute("aria-label") || "");
    return text.includes("show more") ||
        text.includes("showmore") ||
        text.includes("show all") ||
        text.includes("показать больше") ||
        text.includes("показати більше");
}

function isStrictShowMoreText(element) {
    if (element.matches("a") && !hasShowMoreMarker(element)) return false;

    const text = normalizeCategory(element.textContent || element.getAttribute("aria-label") || "");
    if (text.includes("options") || text.includes("information") || text.includes("channel")) return false;

    return text === "show more" ||
        text === "showmore" ||
        text === "show all" ||
        text === "показать больше" ||
        text === "показати більше";
}

function hasShowMoreMarker(element) {
    const marker = normalizeCategory([
        element.getAttribute("data-a-target"),
        element.getAttribute("data-test-selector"),
        element.getAttribute("aria-label"),
        element.className
    ].join(" "));

    return marker.includes("show-more") ||
        marker.includes("showmore") ||
        marker.includes("side-nav-show-more");
}

function getHideReason(info) {
    const channel = info.channel || "?";
    const category = info.category || "unknown category";

    if (settings.channelBlocklist.includes(channel)) return "channel blocklist";

    const channelRules = settings.channelRules.filter((rule) => rule.channel === channel);
    if (channelRules.length) return `channel rule: ${category}`;

    if (settings.categoryMode === "block") return `blocked category: ${category}`;
    if (settings.categoryMode === "allow") return `not in allowed categories: ${category}`;

    return "unknown";
}

runtime.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync" || !changes[STORAGE_KEY]) return;
    settings = normalizeSettings(changes[STORAGE_KEY].newValue);
    scheduleFilterBurst({ allowExpand: true });
});

const observer = new MutationObserver(() => {
    handleRouteChange();
    scheduleFilter();
});

function startObserver() {
    if (document.documentElement) {
        observer.observe(document.documentElement, { childList: true, subtree: true });
        return;
    }

    window.addEventListener("DOMContentLoaded", startObserver, { once: true });
}

installRouteWatchers();
startObserver();
loadSettings();
