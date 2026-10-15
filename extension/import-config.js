function fail(code = 'LEGACY_CONFIG_INVALID') {
  throw Object.assign(new Error(code), { code });
}

function parseValue(raw) {
  const value = raw.trim();
  let result;
  if (value.startsWith('"') || value.startsWith("'")) {
    const quoted = value.match(/^(?:"([^"\\]*)"|'([^']*)')[ \t]*(?:#.*)?$/);
    if (!quoted) fail();
    result = quoted[1] ?? quoted[2];
  } else {
    result = value.split('#', 1)[0].trim();
    if (/["';&|<>]/.test(result) || result.endsWith('\\')) fail();
  }
  // dotenv expansion and shell expressions are deliberately unsupported.
  if (/\$(?:[A-Za-z_]|\{|\()|`/.test(result)) fail();
  return result.trim();
}

export function parseLegacyConfig(text) {
  if (typeof text !== 'string') fail();
  if (text.length > 65536 || new TextEncoder().encode(text).length > 65536) fail('LEGACY_CONFIG_TOO_LARGE');
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)) fail();
  const values = Object.create(null);
  for (const raw of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const assignment = line.match(/^(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*=[ \t]*(.*)$/);
    if (!assignment) fail();
    values[assignment[1]] = parseValue(assignment[2]);
  }
  if (!values.API_KEY) fail('TRANSLATION_KEY_REQUIRED');
  if (values.TRANSLATION_MODE && values.TRANSLATION_MODE !== 'api') fail('LEGACY_CONFIG_MODE_UNSUPPORTED');
  const endpoint = values.ASR_ENDPOINT || '', key = values.DASHSCOPE_API_KEY || '';
  let enabled = Boolean(endpoint && key);
  if (Object.hasOwn(values, 'ASR_ENABLED')) {
    if (!/^(?:true|false|1|0)$/i.test(values.ASR_ENABLED)) fail();
    enabled = /^(?:true|1)$/i.test(values.ASR_ENABLED);
  }
  return {
    translation: { endpoint: values.API_ENDPOINT || '', key: values.API_KEY,
      model: values.API_MODEL || '', thinking: values.API_THINKING || '' },
    asr: { enabled, endpoint, key, model: values.ASR_MODEL || '' },
  };
}
