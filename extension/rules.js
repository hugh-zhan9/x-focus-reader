(function initRules(root) {
  "use strict";

  const mediaTypes = new Set(["image", "video", "gif", "link", "text"]);
  const maxListLength = 1000;
  const maxRuleLength = 160;
  const maxPostLength = 32000;

  function property(object, key) {
    return object && typeof object === "object" && Object.hasOwn(object, key)
      ? object[key]
      : undefined;
  }

  function fold(value) {
    return value.normalize("NFKC").toLowerCase();
  }

  // Fold case and Unicode presentation forms, treating line breaks as spaces.
  // Literal matching does not interpret metacharacters as regex patterns.
  function normalizeText(value, limit) {
    if (typeof value !== "string") return "";
    const folded = fold(value.slice(0, limit)).trim();
    let result = "";
    let space = false;
    for (const character of folded) {
      if (!character.trim()) {
        space = true;
      } else {
        if (space) result += " ";
        result += character;
        space = false;
      }
    }
    return result;
  }

  function normalizeHandle(value) {
    if (typeof value !== "string" || value.length > 64) return "";
    let handle = fold(value).trim();
    if (handle.startsWith("@")) handle = handle.slice(1);
    if (!handle || handle.length > 15) return "";
    for (const character of handle) {
      if (
        character !== "_" &&
        !(character >= "a" && character <= "z") &&
        !(character >= "0" && character <= "9")
      ) return "";
    }
    return handle;
  }

  function normalizeTerm(value) {
    if (typeof value !== "string" || value.length > maxRuleLength) return "";
    const normalized = normalizeText(value, maxRuleLength);
    return normalized.length <= maxRuleLength ? normalized : "";
  }

  function normalizeTopic(value) {
    const topic = normalizeTerm(value);
    const label = topic.startsWith("#") ? topic.slice(1).trim() : topic;
    return label.startsWith("#") ? "" : label;
  }

  function normalizeMediaType(value) {
    const type = normalizeTerm(value);
    if (type === "photo") return "image";
    return mediaTypes.has(type) ? type : "";
  }

  function normalizeList(value, normalize) {
    if (!Array.isArray(value)) return [];
    const found = new Set();
    for (const entry of value.slice(0, maxListLength)) {
      const normalized = normalize(entry);
      if (normalized) found.add(normalized);
    }
    return Array.from(found);
  }

  function normalizeBlocks(value) {
    if (!Array.isArray(value)) return [];
    const found = new Map();
    for (const item of value.slice(0, maxListLength)) {
      const handle = normalizeHandle(property(item, "handle"));
      const expiresAt = property(item, "expiresAt");
      if (!handle || (expiresAt !== null && (!Number.isSafeInteger(expiresAt) || expiresAt < 0))) continue;
      const existing = found.get(handle);
      if (existing === null) continue;
      if (existing === undefined || expiresAt === null || expiresAt > existing) {
        found.set(handle, expiresAt);
      }
    }
    return Array.from(found, ([handle, expiresAt]) => ({ handle, expiresAt }));
  }

  function normalizeSettings(raw) {
    return {
      blockedAuthors: normalizeBlocks(property(raw, "blockedAuthors")),
      whitelistedAuthors: normalizeList(property(raw, "whitelistedAuthors"), normalizeHandle),
      filterQuotedAuthors: property(raw, "filterQuotedAuthors") === true,
      keywords: normalizeList(property(raw, "keywords"), normalizeTerm),
      topics: normalizeList(property(raw, "topics"), normalizeTopic),
      mediaTypes: normalizeList(property(raw, "mediaTypes"), normalizeMediaType),
    };
  }

  // Build once per settings change for live timelines. The returned evaluator
  // closes over a detached snapshot; callers may continue editing the raw data.
  function compile(rawSettings) {
    const settings = normalizeSettings(rawSettings);
    const blocked = new Map(settings.blockedAuthors.map(rule => [rule.handle, rule.expiresAt]));
    const whitelist = new Set(settings.whitelistedAuthors);
    function isBlocked(handle, now) {
      const expiresAt = blocked.get(handle);
      return expiresAt === null || expiresAt > now;
    }

    return function evaluatePost(post, now = Date.now()) {
      const time = Number.isFinite(now) ? now : Date.now();
      const author = normalizeHandle(property(post, "author"));
      const reasons = [];
      if (author && isBlocked(author, time)) {
        reasons.push({ id: "blocked-author", value: author });
      }
      if (settings.filterQuotedAuthors) {
        const quotedAuthor = normalizeHandle(property(post, "quotedAuthor"));
        if (quotedAuthor && isBlocked(quotedAuthor, time)) {
          reasons.push({ id: "blocked-quoted-author", value: quotedAuthor });
        }
      }

      if (!whitelist.has(author)) {
        if (settings.keywords.length) {
          const text = normalizeText(property(post, "text"), maxPostLength);
          for (const keyword of settings.keywords) {
            if (text.includes(keyword)) reasons.push({ id: "keyword", value: keyword });
          }
        }
        if (settings.topics.length) {
          const topics = new Set(normalizeList(property(post, "topics"), normalizeTopic));
          for (const topic of settings.topics) {
            if (topics.has(topic)) reasons.push({ id: "topic", value: topic });
          }
        }
        if (settings.mediaTypes.length) {
          const media = new Set(normalizeList(property(post, "mediaTypes"), normalizeMediaType));
          for (const type of settings.mediaTypes) {
            if (media.has(type)) reasons.push({ id: "media-type", value: type });
          }
        }
      }
      return { hidden: reasons.length > 0, reasons };
    };
  }

  function evaluate(post, settings, now) {
    return compile(settings)(post, now);
  }

  root.XFRRules = Object.freeze({ normalizeHandle, normalizeSettings, compile, evaluate });
})(globalThis);
