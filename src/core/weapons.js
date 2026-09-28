/* Weapon catalogue for grouping Gunsmith presets.
 *
 * Preset rows carry a free-text `weapon` string, typed by whoever submitted the
 * code. That string cannot be trusted to group by: the live data contains
 * "EasyB AS Val Assault Rifle" and "Upstairs-Pirate-9890 AKS-74 Assault Rifle"
 * (a Reddit author's handle glued onto the gun), "Súng Trường Xạ Thủ SVCH"
 * (Vietnamese for a gun the catalogue lists in English), and "Tay Đen" (not a
 * Delta Force weapon at all). Grouping on the raw string produced 18 buckets
 * for 20 presets, which is not a grouping.
 *
 * So we resolve the free text against this catalogue instead, and keep the
 * original string for display. Names and classes are from the Delta Force wiki
 * Firearms page (delta-force.fandom.com/wiki/Firearms, 67 entries, current for
 * Havoc Warfare). Vietnamese labels follow the in-game VN client where a term
 * exists; ones that ship untranslated in game keep the English name so a player
 * reading the panel sees what they will see in Gunsmith.
 */
(function (root) {
  'use strict';

/* Classes in the order the in-game Gunsmith lists them, so the panel's section
 * order matches the game rather than being alphabetical. */
const WEAPON_CLASSES = [
  { id: 'ar', label: 'Súng Trường Tấn Công', en: 'Assault Rifle' },
  { id: 'br', label: 'Súng Trường Chiến Đấu', en: 'Battle Rifle' },
  { id: 'smg', label: 'Súng Tiểu Liên', en: 'Submachine Gun' },
  { id: 'lmg', label: 'Súng Máy', en: 'Machine Gun' },
  { id: 'dmr', label: 'Súng Trường Xạ Thủ', en: 'Marksman Rifle' },
  { id: 'sr', label: 'Súng Bắn Tỉa', en: 'Sniper Rifle' },
  { id: 'sg', label: 'Súng Shotgun', en: 'Shotgun' },
  { id: 'pistol', label: 'Súng Ngắn', en: 'Pistol' },
  { id: 'special', label: 'Vũ Khí Đặc Biệt', en: 'Special' },
];

/* name = exactly as the wiki/game lists it; aliases = other spellings seen in
 * submitted data (Vietnamese names, common abbreviations). Matching is done on
 * a normalised form, so case and diacritics do not need repeating here. */
const WEAPONS = [
  /* Assault rifles */
  { name: 'AKS-74 Assault Rifle', cls: 'ar', aliases: ['AKS-74', 'AKS74'] },
  { name: 'CAR-15 Assault Rifle', cls: 'ar', aliases: ['CAR-15', 'CAR15'] },
  { name: 'QBZ95-1 Assault Rifle', cls: 'ar', aliases: ['QBZ95-1', 'QBZ95'] },
  { name: 'M4A1 Assault Rifle', cls: 'ar', aliases: ['M4A1', 'M4'] },
  { name: 'M16A4 Assault Rifle', cls: 'ar', aliases: ['M16A4', 'M16'] },
  { name: 'SG 552 Assault Rifle', cls: 'ar', aliases: ['SG552', 'SG 552'] },
  { name: 'AK-12 Assault Rifle', cls: 'ar', aliases: ['AK-12', 'AK12'] },
  { name: 'PTR-32 Assault Rifle', cls: 'ar', aliases: ['PTR-32', 'PTR32'] },
  { name: 'AKM Assault Rifle', cls: 'ar', aliases: ['AKM'] },
  { name: 'AS Val Assault Rifle', cls: 'ar', aliases: ['AS Val', 'ASVal', 'AS-Val'] },
  { name: 'CI-19 Assault Rifle', cls: 'ar', aliases: ['CI-19', 'CI19'] },
  { name: 'K416 Assault Rifle', cls: 'ar', aliases: ['K416'] },
  { name: 'AUG Assault Rifle', cls: 'ar', aliases: ['AUG'] },
  { name: 'K437 Assault Rifle', cls: 'ar', aliases: ['K437'] },
  { name: 'KC17 Assault Rifle', cls: 'ar', aliases: ['KC17'] },
  { name: 'MCX LT Assault Rifle', cls: 'ar', aliases: ['MCX LT', 'MCX'] },
  { name: 'AR-57 Assault Rifle', cls: 'ar', aliases: ['AR-57', 'AR57'] },
  { name: 'RM227 Assault Rifle', cls: 'ar', aliases: ['RM227'] },
  { name: 'MDR Assault Rifle', cls: 'ar', aliases: ['MDR'] },
  { name: 'SR-3M Compact Assault Rifle', cls: 'ar', aliases: ['SR-3M', 'SR3M'] },
  /* Battle rifles — a separate Gunsmith class in game, though the wiki lists
   * them under Rifle alongside assault rifles. */
  { name: 'G3 Battle Rifle', cls: 'br', aliases: ['G3'] },
  { name: 'SCAR-H Battle Rifle', cls: 'br', aliases: ['SCAR-H', 'SCAR', 'SCARH'] },
  { name: 'Ash-12 Battle Rifle', cls: 'br', aliases: ['Ash-12', 'Ash12'] },
  { name: 'M7 Battle Rifle', cls: 'br', aliases: ['M7'] },
  { name: 'MK47 Battle Rifle', cls: 'br', aliases: ['MK47', 'MK-47'] },
  /* SMGs */
  { name: 'UZI Submachine Gun', cls: 'smg', aliases: ['UZI'] },
  { name: 'Bizon Submachine Gun', cls: 'smg', aliases: ['Bizon', 'PP-19'] },
  { name: 'SMG-45 Submachine Gun', cls: 'smg', aliases: ['SMG-45', 'SMG45'] },
  { name: 'MP5 Submachine Gun', cls: 'smg', aliases: ['MP5'] },
  { name: 'Vector Submachine Gun', cls: 'smg', aliases: ['Vector'] },
  { name: 'MP7 Submachine Gun', cls: 'smg', aliases: ['MP7'] },
  { name: 'P90 Submachine Gun', cls: 'smg', aliases: ['P90'] },
  { name: 'Vityaz Submachine Gun', cls: 'smg', aliases: ['Vityaz'] },
  { name: 'QCQ171 Submachine Gun', cls: 'smg', aliases: ['QCQ171', 'QCQ-171'] },
  { name: 'MK4 Submachine Gun', cls: 'smg', aliases: ['MK4', 'MK-4'] },
  { name: 'Thompson Submachine Gun', cls: 'smg', aliases: ['Thompson'] },
  /* Machine guns */
  { name: 'M249 Light Machine Gun', cls: 'lmg', aliases: ['M249'] },
  { name: 'QJB 201 Light Machine Gun', cls: 'lmg', aliases: ['QJB 201', 'QJB201'] },
  { name: 'PKM General Machine Gun', cls: 'lmg', aliases: ['PKM'] },
  { name: 'M250 General Machine Gun', cls: 'lmg', aliases: ['M250'] },
  /* Marksman rifles */
  { name: 'Mini-14 Marksman Rifle', cls: 'dmr', aliases: ['Mini-14', 'Mini14'] },
  { name: 'VSS Marksman Rifle', cls: 'dmr', aliases: ['VSS'] },
  { name: 'PSG-1 Marksman Rifle', cls: 'dmr', aliases: ['PSG-1', 'PSG1'] },
  { name: 'SR-25 Marksman Rifle', cls: 'dmr', aliases: ['SR-25', 'SR25'] },
  { name: 'SKS Marksman Rifle', cls: 'dmr', aliases: ['SKS'] },
  { name: 'M14 Marksman Rifle', cls: 'dmr', aliases: ['M14'] },
  { name: 'SR9 Marksman Rifle', cls: 'dmr', aliases: ['SR9'] },
  { name: 'Marlin Lever-action Rifle', cls: 'dmr', aliases: ['Marlin'] },
  /* SVD sits under Marksman Rifle on the wiki despite the "Sniper" in its
   * name; keep the wiki's class so the count matches the page. */
  { name: 'SVD Sniper Rifle', cls: 'dmr', aliases: ['SVD'] },
  /* The VN client ships a Vietnamese name for the SVCH; submitted data uses it,
   * so it must resolve rather than becoming its own bucket. */
  { name: 'SVCH Marksman Rifle', cls: 'dmr', aliases: ['SVCH', 'Súng Trường Xạ Thủ SVCH', 'Sung Truong Xa Thu SVCH'] },
  /* Sniper rifles */
  { name: 'SV-98 Sniper Rifle', cls: 'sr', aliases: ['SV-98', 'SV98'] },
  { name: 'R93 Sniper Rifle', cls: 'sr', aliases: ['R93'] },
  { name: 'M700 Sniper Rifle', cls: 'sr', aliases: ['M700'] },
  { name: 'AWM Sniper Rifle', cls: 'sr', aliases: ['AWM'] },
  { name: 'Barrett M82 Sniper Rifle', cls: 'sr', aliases: ['Barrett M82', 'Barrett', 'M82'] },
  /* Shotguns */
  { name: 'M1014 Shotgun', cls: 'sg', aliases: ['M1014'] },
  { name: 'S12K Shotgun', cls: 'sg', aliases: ['S12K', 'Saiga'] },
  { name: 'M870 Shotgun', cls: 'sg', aliases: ['M870'] },
  { name: '725 Double Barrel Shotgun', cls: 'sg', aliases: ['725'] },
  { name: 'FS-12 Shotgun', cls: 'sg', aliases: ['FS-12', 'FS12'] },
  /* Pistols */
  { name: 'G17', cls: 'pistol', aliases: ['Glock 17', 'Glock17'] },
  { name: 'G18', cls: 'pistol', aliases: ['Glock 18', 'Glock18'] },
  { name: 'QSZ-92G', cls: 'pistol', aliases: ['QSZ-92G', 'QSZ92G', 'QSZ-92'] },
  { name: '93R', cls: 'pistol', aliases: ['Beretta 93R'] },
  { name: 'Desert Eagle', cls: 'pistol', aliases: ['Deagle'] },
  { name: '.357 Revolver', cls: 'pistol', aliases: ['357 Revolver', 'Revolver'] },
  { name: 'M1911', cls: 'pistol', aliases: ['1911'] },
  /* Special */
  { name: 'Compound Bow', cls: 'special', aliases: ['Bow', 'Cung'] },
];

/* Diacritics stripped and punctuation dropped so "AS Val", "as-val" and
 * "ASVAL" all land on the same key, and so Vietnamese aliases match whether or
 * not the submitter typed the accents. */
function normWeapon(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '');
}

/* name -> canonical entry, including every alias. */
const WEAPON_INDEX = (() => {
  const ix = new Map();
  for (const w of WEAPONS) {
    ix.set(normWeapon(w.name), w);
    for (const a of w.aliases || []) ix.set(normWeapon(a), w);
    /* Bare model name, so "AKM Assault Rifle" also matches a submission that
     * said only "AKM" without listing it as an explicit alias. */
    const bare = w.name.replace(/\s+(Assault Rifle|Battle Rifle|Submachine Gun|Light Machine Gun|General Machine Gun|Marksman Rifle|Sniper Rifle|Shotgun|Compact Assault Rifle|Double Barrel Shotgun|Lever-action Rifle)$/i, '');
    if (bare !== w.name) ix.set(normWeapon(bare), w);
  }
  return ix;
})();

/* Longest-match-wins so an author handle glued to the front ("EasyB AS Val
 * Assault Rifle", "Upstairs-Pirate-9890 AKS-74 Assault Rifle") still resolves:
 * we look for any catalogue entry whose normalised name appears inside the
 * normalised input, preferring the longest so "AK-12" never wins over "AKM"
 * inside a longer string that contains both. */
function resolveWeapon(raw) {
  const n = normWeapon(raw);
  if (!n) return null;
  const exact = WEAPON_INDEX.get(n);
  if (exact) return exact;
  let best = null;
  let bestLen = 0;
  for (const [key, w] of WEAPON_INDEX) {
    if (key.length > bestLen && key.length >= 3 && n.includes(key)) {
      best = w;
      bestLen = key.length;
    }
  }
  return best;
}

const CLASS_BY_ID = new Map(WEAPON_CLASSES.map((c) => [c.id, c]));

/* What the panel renders for one preset: the resolved class (or the "unknown"
 * bucket), plus whether the submitted string differed from the catalogue name
 * so the UI can show the original without pretending it is canonical. */
function classifyPreset(preset) {
  const raw = String((preset && (preset.weapon || preset.gun)) || '').trim();
  const w = resolveWeapon(raw);
  if (!w) {
    return { cls: 'unknown', clsLabel: 'Chưa rõ loại súng', weapon: raw || '—', canonical: null, raw };
  }
  const c = CLASS_BY_ID.get(w.cls);
  return {
    cls: w.cls,
    clsLabel: (c && c.label) || w.cls,
    clsEn: (c && c.en) || '',
    weapon: w.name,
    canonical: w.name,
    /* Only surfaced when it adds information, i.e. the submitter typed
     * something other than the catalogue name. */
    raw: normWeapon(raw) === normWeapon(w.name) ? '' : raw,
  };
}

  const api = {
    WEAPON_CLASSES,
    WEAPONS,
    WEAPON_INDEX,
    normWeapon,
    resolveWeapon,
    classifyPreset,
  };
  root.DFRedeemWeapons = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  return api;
}(typeof window !== 'undefined' ? window : globalThis));
