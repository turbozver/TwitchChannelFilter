const STORAGE_KEY = "twitchChannelFilterSettings";

const DEFAULT_SETTINGS = {
    enabled: true,
    channelAllowlist: [],
    channelBlocklist: [],
    categoryMode: "off",
    categoryBlocklist: [],
    categoryAllowlist: [],
    channelRules: [],
    ruleGroupMode: "none"
};

const runtime = typeof chrome !== "undefined" ? chrome : browser;
const elements = {
    enabled: document.getElementById("enabled"),
    status: document.getElementById("status"),
    mainView: document.getElementById("mainView"),
    settingsView: document.getElementById("settingsView"),
    navButton: document.getElementById("navButton"),
    pageTabs: document.querySelectorAll("[data-page-tab]"),
    pagePanels: document.querySelectorAll("[data-page-panel]"),
    channelSearchInput: document.getElementById("channelSearchInput"),
    categorySearchInput: document.getElementById("categorySearchInput"),
    categoryBlockInput: document.getElementById("categoryBlockInput"),
    categoryBlockAdd: document.getElementById("categoryBlockAdd"),
    categoryBlockList: document.getElementById("categoryBlockList"),
    categoryAllowInput: document.getElementById("categoryAllowInput"),
    categoryAllowAdd: document.getElementById("categoryAllowAdd"),
    categoryAllowList: document.getElementById("categoryAllowList"),
    ruleChannelInput: document.getElementById("ruleChannelInput"),
    ruleCategoryInput: document.getElementById("ruleCategoryInput"),
    saveRule: document.getElementById("saveRule"),
    ruleSearchInput: document.getElementById("ruleSearchInput"),
    rules: document.getElementById("rules"),
    itemTemplate: document.getElementById("itemTemplate"),
    ruleTemplate: document.getElementById("ruleTemplate"),
    exportBtn: document.getElementById("exportBtn"),
    importBtn: document.getElementById("importBtn"),
    importFile: document.getElementById("importFile"),
    resetBtn: document.getElementById("resetBtn")
};

let state = { ...DEFAULT_SETTINGS };
let draftMode = "block";
let saveTimer = null;
let settingsOpen = false;
let activePage = "channels";

function normalizeChannel(value) {
    return String(value || "").trim().replace(/^@+/, "").toLowerCase();
}

function normalizeCategory(value) {
    return String(value || "").trim().replace(/\s+/g, " ");
}

function normalizeList(value, normalizer) {
    const source = Array.isArray(value) ? value : String(value || "").split(/\r?\n|,/);
    return [...new Set(source.map(normalizer).filter(Boolean))];
}

function normalizeSettings(raw) {
    const merged = { ...DEFAULT_SETTINGS, ...(raw || {}) };
    const legacyCategoryList = normalizeList(merged.categoryList, normalizeCategory);
    const categoryBlocklist = normalizeList(merged.categoryBlocklist, normalizeCategory);
    const categoryAllowlist = normalizeList(merged.categoryAllowlist, normalizeCategory);

    return {
        enabled: Boolean(merged.enabled),
        channelAllowlist: normalizeList(merged.channelAllowlist, normalizeChannel),
        channelBlocklist: normalizeList(merged.channelBlocklist, normalizeChannel),
        categoryMode: ["off", "block", "allow"].includes(merged.categoryMode) ? merged.categoryMode : "off",
        categoryBlocklist: categoryBlocklist.length ? categoryBlocklist : (merged.categoryMode === "block" ? legacyCategoryList : []),
        categoryAllowlist: categoryAllowlist.length ? categoryAllowlist : (merged.categoryMode === "allow" ? legacyCategoryList : []),
        channelRules: normalizeChannelRules(merged.channelRules),
        ruleGroupMode: ["none", "channel", "category"].includes(merged.ruleGroupMode) ? merged.ruleGroupMode : "none"
    };
}

function normalizeChannelRules(value) {
    if (!Array.isArray(value)) return [];

    const rules = value.flatMap((rule, index) => {
        const channel = normalizeChannel(rule.channel);
        const mode = rule.mode === "allow" ? "allow" : "block";
        const createdAt = Number(rule.createdAt) || Date.now() - index;
        const categories = rule.category
            ? [normalizeCategory(rule.category)]
            : normalizeList(rule.categories || [], normalizeCategory);

        return categories
            .filter(Boolean)
            .map((category, categoryIndex) => ({
                channel,
                mode,
                category,
                createdAt: createdAt - categoryIndex
            }));
    }).filter((rule) => rule.channel && rule.category);

    return dedupeRules(rules).sort((a, b) => b.createdAt - a.createdAt);
}

function dedupeRules(rules) {
    const seen = new Set();

    return rules.filter((rule) => {
        const key = `${rule.channel}\u0000${rule.mode}\u0000${rule.category}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

function getFromStorage(keys) {
    return new Promise((resolve) => runtime.storage.sync.get(keys, resolve));
}

function setToStorage(value) {
    return new Promise((resolve) => runtime.storage.sync.set(value, resolve));
}

async function load() {
    const result = await getFromStorage([STORAGE_KEY]);
    state = normalizeSettings(result[STORAGE_KEY]);
    render();
}

function render() {
    elements.enabled.checked = state.enabled;
    updateStatus();
    renderPage();
    renderChannelLists();
    renderCategoryMode();
    renderCategoryLists();
    renderDraftMode();
    renderRuleGroupMode();
    renderRules();
}

function renderPage() {
    elements.pageTabs.forEach((button) => {
        const active = button.dataset.pageTab === activePage;
        button.classList.toggle("active", active);
        button.setAttribute("aria-selected", String(active));
    });

    elements.pagePanels.forEach((panel) => {
        const active = panel.dataset.pagePanel === activePage;
        panel.classList.toggle("active", active);
        panel.hidden = !active;
    });
}

function updateStatus() {
    elements.status.textContent = state.enabled ? "Enabled" : "Disabled";
}

function renderChannelLists() {
    const query = normalizeChannel(elements.channelSearchInput.value);
    renderList("channelAllowlist", document.querySelector('[data-list="channelAllowlist"]'), query, normalizeChannel);
    renderList("channelBlocklist", document.querySelector('[data-list="channelBlocklist"]'), query, normalizeChannel);
}

function renderList(name, list, query = "", normalizer = normalizeCategory) {
    const values = query
        ? state[name].filter((value) => normalizer(value).includes(query))
        : state[name];

    list.textContent = "";
    list.classList.toggle("empty", values.length === 0);

    for (const value of values) {
        list.appendChild(createItem(value, () => {
            state[name] = state[name].filter((item) => item !== value);
            render();
            scheduleSave();
        }));
    }
}

function renderCategoryMode() {
    document.querySelectorAll("[data-category-mode]").forEach((button) => {
        const active = button.dataset.categoryMode === state.categoryMode;
        button.classList.toggle("active", active);
        button.setAttribute("aria-selected", String(active));
    });

    document.querySelectorAll("[data-category-panel]").forEach((panel) => {
        const active = panel.dataset.categoryPanel === state.categoryMode;
        panel.classList.toggle("active", active);
        panel.hidden = !active;
    });
}

function renderCategoryLists() {
    const query = normalizeCategory(elements.categorySearchInput.value);
    renderList("categoryBlocklist", elements.categoryBlockList, query, normalizeCategory);
    renderList("categoryAllowlist", elements.categoryAllowList, query, normalizeCategory);
}

function addCategory(name, input) {
    addListItem(name, input, normalizeCategory);
}

function renderDraftMode() {
    document.querySelectorAll("[data-rule-draft-mode]").forEach((button) => {
        button.classList.toggle("active", button.dataset.ruleDraftMode === draftMode);
    });
}

function renderRuleGroupMode() {
    document.querySelectorAll("[data-rule-group-mode]").forEach((button) => {
        button.classList.toggle("active", button.dataset.ruleGroupMode === state.ruleGroupMode);
    });
}

function renderRules() {
    const rules = getVisibleRules();
    elements.rules.textContent = "";
    elements.rules.classList.toggle("empty", rules.length === 0);
    if (!rules.length) return;

    if (state.ruleGroupMode === "none") {
        for (const rule of rules) {
            elements.rules.appendChild(createRuleCard(rule));
        }
        return;
    }

    const groups = groupRules(rules, state.ruleGroupMode);
    for (const group of groups) {
        const section = document.createElement("section");
        section.className = "rule-group";

        const title = document.createElement("div");
        title.className = "rule-group-title";
        title.textContent = group.label;
        section.appendChild(title);

        for (const rule of group.rules) {
            section.appendChild(createRuleCard(rule));
        }

        elements.rules.appendChild(section);
    }
}

function getVisibleRules() {
    const query = normalizeCategory(elements.ruleSearchInput.value);
    if (!query) return state.channelRules;

    return state.channelRules.filter((rule) => (
        normalizeChannel(rule.channel).includes(query) ||
        normalizeCategory(rule.category).includes(query)
    ));
}

function groupRules(rules, mode) {
    const map = new Map();
    for (const rule of rules) {
        const key = mode === "category" ? rule.category : rule.channel;
        if (!map.has(key)) map.set(key, []);
        map.get(key).push(rule);
    }

    return [...map.entries()]
        .map(([label, groupedRules]) => ({ label, rules: groupedRules }))
        .sort((a, b) => newestRuleTime(b.rules) - newestRuleTime(a.rules));
}

function newestRuleTime(rules) {
    return Math.max(...rules.map((rule) => rule.createdAt || 0));
}

function createRuleCard(rule) {
    const node = elements.ruleTemplate.content.firstElementChild.cloneNode(true);
    node.classList.toggle("allow", rule.mode === "allow");
    node.classList.toggle("block", rule.mode !== "allow");
    node.title = rule.mode === "allow" ? "Show Only Matches" : "Hide Matches";
    node.querySelector(".rule-channel").textContent = rule.channel;
    node.querySelector(".rule-card-category").textContent = rule.category;
    node.querySelector(".remove-rule").addEventListener("click", () => {
        removeRule(rule);
    });
    return node;
}

function createItem(value, onRemove) {
    const item = elements.itemTemplate.content.firstElementChild.cloneNode(true);
    item.querySelector(".item-text").textContent = value;
    item.querySelector("button").addEventListener("click", onRemove);
    return item;
}

function addListItem(name, input, normalizer) {
    const value = normalizer(input.value);
    if (!value) return;

    if (!state[name].includes(value)) {
        state[name].push(value);
    }

    input.value = "";
    render();
    scheduleSave();
}

function addRule() {
    const channel = normalizeChannel(elements.ruleChannelInput.value);
    const category = normalizeCategory(elements.ruleCategoryInput.value);
    if (!channel || !category) return;

    const nextRule = {
        channel,
        category,
        mode: draftMode,
        createdAt: Date.now()
    };

    state.channelRules = dedupeRules([nextRule, ...state.channelRules]);
    elements.ruleCategoryInput.value = "";
    renderRules();
    scheduleSave();
}

function removeRule(ruleToRemove) {
    state.channelRules = state.channelRules.filter((rule) => (
        rule.channel !== ruleToRemove.channel ||
        rule.mode !== ruleToRemove.mode ||
        rule.category !== ruleToRemove.category ||
        rule.createdAt !== ruleToRemove.createdAt
    ));
    renderRules();
    scheduleSave();
}

function scheduleSave() {
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(save, 160);
}

async function save() {
    state = normalizeSettings(state);
    await setToStorage({ [STORAGE_KEY]: state });
    render();
}

function showSettings(show) {
    settingsOpen = show;
    elements.mainView.classList.toggle("hidden", show);
    elements.settingsView.classList.toggle("hidden", !show);
    elements.navButton.innerHTML = show ? "&#8617;" : "&#9881;";
    elements.navButton.classList.toggle("back-button", show);
    elements.navButton.title = show ? "Back" : "Settings";
    elements.navButton.setAttribute("aria-label", show ? "Back" : "Settings");
}

function exportSettings() {
    const blob = new Blob([JSON.stringify(normalizeSettings(state), null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "twitch-channel-filter-settings.json";
    link.click();
    URL.revokeObjectURL(url);
}

function importSettings(file) {
    if (!file) return;

    const reader = new FileReader();
    reader.addEventListener("load", async () => {
        try {
            state = normalizeSettings(JSON.parse(String(reader.result || "{}")));
            await save();
        } finally {
            elements.importFile.value = "";
        }
    });
    reader.readAsText(file);
}

document.addEventListener("click", (event) => {
    const button = event.target.closest("[data-add-button]");
    if (!button) return;

    const name = button.dataset.addButton;
    addListItem(name, document.querySelector(`[data-add-input="${name}"]`), normalizeChannel);
});

document.addEventListener("keydown", (event) => {
    const input = event.target.closest("[data-add-input]");
    if (!input || event.key !== "Enter") return;

    event.preventDefault();
    addListItem(input.dataset.addInput, input, normalizeChannel);
});

document.querySelectorAll("[data-category-mode]").forEach((button) => {
    button.addEventListener("click", () => {
        state.categoryMode = button.dataset.categoryMode;
        renderCategoryMode();
        scheduleSave();
    });
});

elements.pageTabs.forEach((button) => {
    button.addEventListener("click", () => {
        activePage = button.dataset.pageTab;
        renderPage();
    });
});

document.querySelectorAll("[data-rule-draft-mode]").forEach((button) => {
    button.addEventListener("click", () => {
        draftMode = button.dataset.ruleDraftMode === "allow" ? "allow" : "block";
        renderDraftMode();
    });
});

document.querySelectorAll("[data-rule-group-mode]").forEach((button) => {
    button.addEventListener("click", () => {
        state.ruleGroupMode = button.dataset.ruleGroupMode;
        renderRuleGroupMode();
        renderRules();
        scheduleSave();
    });
});

elements.enabled.addEventListener("change", () => {
    state.enabled = elements.enabled.checked;
    updateStatus();
    scheduleSave();
});

elements.categoryBlockAdd.addEventListener("click", () => addCategory("categoryBlocklist", elements.categoryBlockInput));
elements.categoryBlockInput.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    addCategory("categoryBlocklist", elements.categoryBlockInput);
});

elements.categoryAllowAdd.addEventListener("click", () => addCategory("categoryAllowlist", elements.categoryAllowInput));
elements.categoryAllowInput.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    addCategory("categoryAllowlist", elements.categoryAllowInput);
});

elements.ruleCategoryInput.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    addRule();
});
elements.saveRule.addEventListener("click", addRule);
elements.channelSearchInput.addEventListener("input", renderChannelLists);
elements.categorySearchInput.addEventListener("input", renderCategoryLists);
elements.ruleSearchInput.addEventListener("input", renderRules);
elements.navButton.addEventListener("click", () => showSettings(!settingsOpen));
elements.exportBtn.addEventListener("click", exportSettings);
elements.importBtn.addEventListener("click", () => elements.importFile.click());
elements.importFile.addEventListener("change", () => importSettings(elements.importFile.files[0]));
elements.resetBtn.addEventListener("click", async () => {
    if (!confirm("Delete all Twitch Channel Filter settings?")) return;
    state = { ...DEFAULT_SETTINGS, channelAllowlist: [], channelBlocklist: [], categoryBlocklist: [], categoryAllowlist: [], channelRules: [] };
    await save();
});

load();


document.querySelectorAll("[data-rate-link]").forEach((link) => {
    if (navigator.userAgent.includes("Firefox")) {
        link.href = link.dataset.firefoxUrl;
    }
});
