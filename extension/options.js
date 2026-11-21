(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const rules = globalThis.XFRRules;
  const store = chrome.storage.local;
  const inputs = {
    next: $("key-next"), previous: $("key-previous"), open: $("key-open"), origin: $("key-back"),
  };
  const labels = {next: "下一条", previous: "上一条", open: "打开帖子", origin: "返回时间线"};
  const defaults = globalThis.XFRReading.DEFAULT_KEYS;
  const presets = new Set(["following", "clean", "original"]);
  const mediaKinds = new Set(["image", "video", "gif", "link", "text"]);
  const namedKeys = new Map(["Enter", "Escape", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "PageUp", "PageDown", "Home", "End"].map(key => [key.toLowerCase(), key]));
  const maxBackupSize = 3 * 1024 * 1024;
  const maxRules = 1000;
  const maxExpiry = 8640000000000000;
  const dirty = new Map();
  let ready = false;
  let pendingWrites = Promise.resolve();
  let importRequest = 0;
  let pendingImport = null;
  let importing = false;

  function object(value) { return !!value && typeof value === "object" && !Array.isArray(value); }

  function status(message, error = false) {
    $("status").textContent = message;
    $("status").dataset.error = String(error);
  }

  function keyCode(value) {
    if (typeof value !== "string" || value.length > 16) return null;
    const key = value.trim().toLowerCase();
    if (!key || /^[a-z0-9]$/.test(key)) return key;
    return namedKeys.get(key) ?? null;
  }

  function readingSettings(raw) {
    const shortcuts = {};
    for (const field of Object.keys(inputs)) {
      const value = raw?.shortcuts?.[field];
      shortcuts[field] = keyCode(value) ?? defaults[field];
    }
    return {
      preset: presets.has(raw?.preset) ? raw.preset : "following",
      shortcutsEnabled: raw?.shortcutsEnabled !== false,
      shortcuts,
    };
  }

  function validateKeys(values) {
    const shortcuts = {};
    const used = new Set();
    for (const field of Object.keys(inputs)) {
      const key = keyCode(values[field]);
      if (key === null) throw new Error(labels[field] + "的快捷键无效。");
      if (key && used.has(key)) throw new Error("不同操作不能使用同一个快捷键：" + key);
      if (key) used.add(key);
      shortcuts[field] = key;
    }
    return shortcuts;
  }

  async function latest() {
    const {settings} = await store.get("settings");
    return object(settings) ? settings : {};
  }

  function write(change) {
    const run = pendingWrites.catch(() => {}).then(async () => {
      const current = await latest();
      const next = {...current, ...change(current)};
      await store.set({settings: next});
      return next;
    });
    pendingWrites = run;
    return run;
  }

  function renderBlacklist(raw) {
    const entries = rules.normalizeSettings(raw).blockedAuthors
      .filter(({expiresAt}) => expiresAt === null || (expiresAt > Date.now() && expiresAt <= maxExpiry))
      .sort((a, b) => a.handle.localeCompare(b.handle));
    const list = $("blacklist");
    list.replaceChildren();
    $("blacklist-empty").hidden = entries.length !== 0;
    for (const entry of entries) {
      const item = document.createElement("li");
      const description = document.createElement("span");
      const name = document.createElement("strong");
      const expiry = document.createElement("small");
      const remove = document.createElement("button");
      name.textContent = "@" + entry.handle;
      expiry.textContent = entry.expiresAt === null
        ? "已屏蔽"
        : new Date(entry.expiresAt).toLocaleString("zh-CN", {dateStyle: "short", timeStyle: "short"}) + " 到期";
      description.append(name, expiry);
      remove.type = "button";
      remove.className = "secondary";
      remove.textContent = "移除";
      remove.setAttribute("aria-label", "移除 @" + entry.handle + " 的隐藏规则");
      remove.addEventListener("click", async () => {
        remove.disabled = true;
        try {
          const next = await write(current => ({
            blockedAuthors: rules.normalizeSettings(current).blockedAuthors.filter(item => item.handle !== entry.handle),
          }));
          renderBlacklist(next);
          $("blocked-handle").focus();
          status("已移除 @" + entry.handle + " 的隐藏规则。");
        } catch {
          remove.disabled = false;
          status("移除失败，稍后再试。", true);
        }
      });
      item.append(description, remove);
      list.append(item);
    }
  }

  function render(raw) {
    renderBlacklist(raw);
    if (!dirty.has("reading")) {
      const current = readingSettings(raw);
      for (const radio of document.querySelectorAll('[name="preset"]')) radio.checked = current.preset === radio.value;
      $("shortcuts-enabled").checked = current.shortcutsEnabled;
      for (const field of Object.keys(inputs)) inputs[field].value = current.shortcuts[field];
    }
    if (!dirty.has("rules")) {
      const current = rules.normalizeSettings(raw);
      $("filter-quoted").checked = current.filterQuotedAuthors;
      $("keywords").value = current.keywords.join("\n");
      $("topics").value = current.topics.map(topic => "#" + topic).join("\n");
      $("whitelisted").value = current.whitelistedAuthors.map(handle => "@" + handle).join("\n");
      for (const box of document.querySelectorAll('[name="media"]')) box.checked = current.mediaTypes.includes(box.value);
    }
  }

  function splitLines(value) { return value.split(/\r?\n/).map(line => line.trim()).filter(Boolean); }
  function checked(name) {
    return [...document.querySelectorAll('[name="' + name + '"]:checked')].map(element => element.value);
  }
  function validRuleList(list, entryTest) {
    return Array.isArray(list) && list.length <= maxRules && list.every(entryTest);
  }
  function validTerm(value) { return typeof value === "string" && !!value.trim() && value.length <= 160; }
  function validTopic(value) { return validTerm(value) && !!value.normalize("NFKC").trim().replace(/^#/, "").trim(); }
  function validHandle(value) { return !!rules.normalizeHandle(value); }
  function validBlock(value) {
    return object(value) && validHandle(value.handle) &&
      (value.expiresAt === null || (Number.isSafeInteger(value.expiresAt) && value.expiresAt >= 0 && value.expiresAt <= maxExpiry));
  }
  function validateRules(value) {
    if (!validRuleList(value.blockedAuthors, validBlock) ||
        !validRuleList(value.whitelistedAuthors, validHandle) ||
        !validRuleList(value.keywords, validTerm) ||
        !validRuleList(value.topics, validTopic) ||
        !validRuleList(value.mediaTypes, entry => mediaKinds.has(entry)) ||
        typeof value.filterQuotedAuthors !== "boolean") {
      throw new Error("内容规则无效：最多 1000 项，每个关键词或话题不超过 160 个字符；账号应为有效的 X 用户名。");
    }
    return rules.normalizeSettings(value);
  }

  function readBackup(text) {
    let backup;
    try { backup = JSON.parse(text); }
    catch { throw new Error("无法读取 JSON，请选择扩展导出的文件。"); }
    if (!object(backup) || backup.version !== 1 || !object(backup.settings)) {
      throw new Error("不支持的备份格式或版本。");
    }
    const current = backup.settings;
    if (!presets.has(current.preset) || typeof current.shortcutsEnabled !== "boolean" || !object(current.shortcuts)) {
      throw new Error("备份中的阅读设置无效。");
    }
    return {
      ...validateRules(current),
      preset: current.preset,
      shortcutsEnabled: current.shortcutsEnabled,
      shortcuts: validateKeys(current.shortcuts),
    };
  }

  function submit(id, section, callback) {
    $(id).addEventListener("input", () => { if (section) dirty.set(section, {}); });
    $(id).addEventListener("submit", async event => {
      event.preventDefault();
      if (!ready) return;
      const button = event.currentTarget.querySelector('[type="submit"]');
      if (button.disabled) return;
      button.disabled = true;
      const edit = dirty.get(section);
      try { await callback(edit); }
      catch (error) { status(error instanceof Error ? error.message : "保存失败，稍后再试。", true); }
      finally { button.disabled = false; }
    });
  }

  submit("blacklist-form", null, async () => {
    const input = $("blocked-handle");
    const handle = rules.normalizeHandle(input.value);
    if (!handle) throw new Error("请输入有效的 X 用户名（字母、数字或下划线，最多 15 个字符）。");
    const next = await write(current => {
      const blockedAuthors = rules.normalizeSettings(current).blockedAuthors.filter(item =>
        item.handle !== handle && (item.expiresAt === null || item.expiresAt > Date.now())
      );
      if (blockedAuthors.length >= maxRules) throw new Error("黑名单已满，请先移除不需要的账号。");
      return {blockedAuthors: [...blockedAuthors, {handle, expiresAt: null}]};
    });
    input.value = "";
    renderBlacklist(next);
    status("已屏蔽 @" + handle + "。");
  });

  submit("reading-form", "reading", async edit => {
    const [preset] = checked("preset");
    const shortcuts = validateKeys(Object.fromEntries(Object.entries(inputs).map(([field, input]) => [field, input.value])));
    if (!presets.has(preset)) throw new Error("请选择一个阅读模式。");
    const shortcutsEnabled = $("shortcuts-enabled").checked;
    const next = await write(() => ({preset, shortcutsEnabled, shortcuts}));
    if (dirty.get("reading") === edit) dirty.delete("reading");
    render(next);
    status("已保存阅读设置。");
  });

  submit("rules-form", "rules", async edit => {
    const draft = {
      blockedAuthors: [],
      filterQuotedAuthors: $("filter-quoted").checked,
      keywords: splitLines($("keywords").value),
      topics: splitLines($("topics").value),
      whitelistedAuthors: splitLines($("whitelisted").value),
      mediaTypes: checked("media"),
    };
    const {blockedAuthors, ...changes} = validateRules(draft);
    const next = await write(() => changes);
    if (dirty.get("rules") === edit) dirty.delete("rules");
    render(next);
    status("已保存内容规则。");
  });

  $("export").addEventListener("click", async () => {
    try {
      await pendingWrites.catch(() => {});
      const raw = await latest();
      const settings = {...rules.normalizeSettings(raw), ...readingSettings(raw)};
      settings.blockedAuthors = settings.blockedAuthors.filter(entry => entry.expiresAt === null || entry.expiresAt <= maxExpiry);
      const file = new Blob([JSON.stringify({version: 1, settings}, null, 2) + "\n"], {type: "application/json"});
      const url = URL.createObjectURL(file);
      const link = document.createElement("a");
      link.href = url;
      link.download = "x-focus-reader-settings.json";
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      status(dirty.size ? "已导出已保存的设置，不包含未保存的编辑。" : "已导出本地设置。");
    } catch { status("导出失败，无法读取本地设置。", true); }
  });

  $("import").addEventListener("change", async event => {
    const request = ++importRequest;
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;
    try {
      if (file.size > maxBackupSize) throw new Error("备份文件不能超过 3 MiB。");
      const settings = readBackup(await file.text());
      if (request !== importRequest) return;
      pendingImport = settings;
      $("import-detail").textContent = "备份包含 " + settings.blockedAuthors.length + " 个黑名单账号、" +
        settings.whitelistedAuthors.length + " 个白名单账号、" + settings.keywords.length + " 个关键词和 " + settings.topics.length + " 个话题。";
      $("import-dialog").showModal();
    } catch (error) {
      if (request === importRequest) status(error.message || "导入失败。", true);
    }
  });
  $("cancel-import").addEventListener("click", () => { if (!importing) $("import-dialog").close(); });
  $("import-dialog").addEventListener("cancel", event => { if (importing) event.preventDefault(); });
  $("import-dialog").addEventListener("close", () => { if (!$("import-dialog").open) pendingImport = null; });
  $("confirm-import").addEventListener("click", async () => {
    if (!pendingImport || importing) return;
    const replacement = pendingImport;
    importing = true;
    $("confirm-import").disabled = $("cancel-import").disabled = true;
    try {
      const next = await write(() => replacement);
      dirty.clear();
      render(next);
      $("import-dialog").close();
      status("已替换本地设置，阅读位置未更改。");
    } catch {
      $("import-dialog").close();
      status("导入失败，未能写入本地设置。", true);
    } finally {
      importing = false;
      $("confirm-import").disabled = $("cancel-import").disabled = false;
    }
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (ready && area === "local" && changes.settings) render(changes.settings.newValue);
  });
  latest().then(raw => {
    render(raw);
    ready = true;
    for (const button of document.querySelectorAll('main [type="submit"], #export, #import')) button.disabled = false;
  }).catch(() => status("无法读取扩展的本地设置。请重新载入此页后再试。", true));
})();
