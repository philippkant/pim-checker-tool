// Catalog check engine: deterministic product-data quality audit for an
// e-commerce CSV export. Detects columns (English + German headers), then
// scores completeness, content quality, and consistency.
//
// No external services — just CSV parsing and field inspection.

import Papa from 'papaparse';

export type CheckStatus = 'pass' | 'warn' | 'fail';

export interface Check {
  id: string;
  label: string;
  status: CheckStatus;
  /** What the audit found — concrete counts. */
  detail: string;
  /** Up to a few offending products, for context. Empty when not useful. */
  examples: string[];
  /** How to fix it — shown when the check is not a pass. */
  fix: string;
  weight: number;
}

export interface Category {
  id: string;
  title: string;
  blurb: string;
  score: number; // 0-100
  checks: Check[];
}

export interface CatalogResult {
  fileName: string;
  rowCount: number;
  columnCount: number;
  /** Canonical fields that were detected, e.g. "title", "price". */
  mapped: string[];
  /** Header names that were not recognised as a known field. */
  unmapped: string[];
  score: number; // 0-100, weighted across every check
  band: 'weak' | 'fair' | 'strong';
  summary: string;
  categories: Category[];
}

/* ------------------------------------------------------------------ */
/* Limits                                                              */
/* ------------------------------------------------------------------ */

export const MAX_BYTES = 8 * 1024 * 1024; // 8 MB
const MAX_ROWS = 20_000; // analyse at most this many products

/* ------------------------------------------------------------------ */
/* Column detection                                                    */
/* ------------------------------------------------------------------ */

type CanonicalField =
  | 'title'
  | 'description'
  | 'price'
  | 'image'
  | 'sku'
  | 'brand'
  | 'category'
  | 'gtin';

const FIELD_PATTERNS: Record<CanonicalField, RegExp> = {
  title:
    /^(title|name|product[\s_-]?name|productname|produkt(name|titel)?|bezeichnung|artikel(name|bezeichnung)?)$/i,
  description:
    /^(description|desc|long[\s_-]?description|product[\s_-]?description|beschreibung|produktbeschreibung|langtext|details)$/i,
  price:
    /^(price|cost|unit[\s_-]?price|sales[\s_-]?price|preis|vk|vk[\s_-]?preis|verkaufspreis|listenpreis|amount)$/i,
  sku: /^(sku|article[\s_-]?(no|number|nr|id)?|articlenumber|artikel(nummer|nr)?|art[\s_-]?nr|artnr|item[\s_-]?(no|number|id)|product[\s_-]?id|productid|mpn)$/i,
  brand: /^(brand|manufacturer|marke|hersteller|vendor|lieferant)$/i,
  image:
    /^(image|image[\s_-]?url|imageurl|images|main[\s_-]?image|picture|photo|bild|bildurl|bild[\s_-]?url|image[\s_-]?link)$/i,
  category:
    /^(category|categories|kategorie|warengruppe|product[\s_-]?type|producttype|product[\s_-]?category|google[\s_-]?product[\s_-]?category)$/i,
  gtin: /^(gtin|gtin13|ean|ean13|upc|barcode|isbn)$/i,
};

type ColumnMap = Partial<Record<CanonicalField, string>>;

function detectColumns(headers: string[]): { map: ColumnMap; unmapped: string[] } {
  const map: ColumnMap = {};
  const used = new Set<string>();

  for (const field of Object.keys(FIELD_PATTERNS) as CanonicalField[]) {
    const pattern = FIELD_PATTERNS[field];
    const match = headers.find((h) => !used.has(h) && pattern.test(h.trim()));
    if (match) {
      map[field] = match;
      used.add(match);
    }
  }
  const unmapped = headers.filter((h) => !used.has(h));
  return { map, unmapped };
}

/* ------------------------------------------------------------------ */
/* Value helpers                                                        */
/* ------------------------------------------------------------------ */

type Row = Record<string, string>;

function cell(row: Row, header: string | undefined): string {
  if (!header) return '';
  const v = row[header];
  return typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
}

/** Identify a row in human terms: prefer SKU, then title, then a row number. */
function rowLabel(row: Row, index: number, map: ColumnMap): string {
  const sku = cell(row, map.sku);
  if (sku) return sku;
  const title = cell(row, map.title);
  if (title) return title.slice(0, 50);
  return `Row ${index + 2}`; // +2: 1-based, plus header row
}

/** Parse a price string, tolerating currency symbols and EU/US decimals. */
function parsePrice(raw: string): number | null {
  let s = raw.replace(/[^\d.,-]/g, '');
  if (!s) return null;
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  if (lastComma > -1 && lastDot > -1) {
    // The right-most separator is the decimal point.
    s = lastComma > lastDot ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  } else if (lastComma > -1) {
    // Comma alone: decimal separator only if it sits near the end.
    s = s.length - lastComma <= 3 ? s.replace(',', '.') : s.replace(/,/g, '');
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function wordCount(text: string): number {
  const clean = text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return clean ? clean.split(' ').length : 0;
}

/* ------------------------------------------------------------------ */
/* Scoring helpers                                                      */
/* ------------------------------------------------------------------ */

function earned(c: Check): number {
  if (c.status === 'pass') return c.weight;
  if (c.status === 'warn') return c.weight * 0.5;
  return 0;
}

function scoreOf(checks: Check[]): number {
  const total = checks.reduce((s, c) => s + c.weight, 0);
  if (total === 0) return 0;
  return Math.round((checks.reduce((s, c) => s + earned(c), 0) / total) * 100);
}

/** Status from a ratio of clean rows: ≥98% pass, ≥85% warn, else fail. */
function statusFromRatio(clean: number, total: number): CheckStatus {
  if (total === 0) return 'warn';
  const ratio = clean / total;
  if (ratio >= 0.98) return 'pass';
  if (ratio >= 0.85) return 'warn';
  return 'fail';
}

function pct(n: number, total: number): string {
  return total === 0 ? '0%' : `${Math.round((n / total) * 100)}%`;
}

/** "1 title" / "3 titles" */
function plural(n: number, singular: string): string {
  return `${n} ${n === 1 ? singular : singular + 's'}`;
}

function isAre(n: number): string {
  return n === 1 ? 'is' : 'are';
}

/* ------------------------------------------------------------------ */
/* Main check                                                           */
/* ------------------------------------------------------------------ */

export function runCheck(csvText: string, fileName: string): CatalogResult {
  const parsed = Papa.parse<Row>(csvText, {
    header: true,
    skipEmptyLines: 'greedy',
    transformHeader: (h) => h.trim(),
  });

  const headers = (parsed.meta.fields ?? []).filter((h) => h && h.length > 0);
  if (headers.length === 0) {
    throw new Error('No column headers found. Make sure the first row of the CSV names the columns.');
  }

  let rows = (parsed.data as Row[]).filter((r) =>
    headers.some((h) => cell(r, h) !== ''),
  );
  if (rows.length === 0) {
    throw new Error('No product rows found in the file.');
  }
  if (rows.length > MAX_ROWS) rows = rows.slice(0, MAX_ROWS);

  const { map, unmapped } = detectColumns(headers);

  // If none of the load-bearing columns are present, this probably is not a
  // product catalog — or the delimiter was misread.
  if (!map.title && !map.sku && !map.price) {
    throw new Error(
      'Could not recognise this as a product catalog — no title, SKU or price column was found. ' +
        'Check the file has a header row and the right delimiter.',
    );
  }

  const total = rows.length;
  const EX = 4; // max examples to surface per check

  /* --- Category 1: Completeness --- */

  function completenessCheck(
    field: CanonicalField,
    label: string,
    weight: number,
    noun: string,
  ): Check {
    const a = /^[aeiou]/i.test(noun) ? 'an' : 'a';
    const header = map[field];
    if (!header) {
      return {
        id: `has-${field}`,
        label,
        weight,
        status: 'fail',
        examples: [],
        detail: `No ${noun} column was detected in the file.`,
        fix: `Add ${a} ${noun} column. Without it, channels and AI engines have nothing to show or match on.`,
      };
    }
    const missing: string[] = [];
    rows.forEach((r, i) => {
      if (cell(r, header) === '') missing.push(rowLabel(r, i, map));
    });
    const filled = total - missing.length;
    return {
      id: `has-${field}`,
      label,
      weight,
      status: statusFromRatio(filled, total),
      examples: missing.slice(0, EX),
      detail:
        missing.length === 0
          ? `Every product has ${a} ${noun} (column “${header}”).`
          : `${missing.length} of ${total} products are missing ${a} ${noun} (${pct(missing.length, total)}).`,
      fix: `Fill in the ${noun} for every product. Incomplete listings rank worse and convert worse.`,
    };
  }

  const completeness: Category = {
    id: 'completeness',
    title: 'Completeness',
    blurb: 'The fields every product needs before it can be listed or found.',
    score: 0,
    checks: [
      completenessCheck('title', 'Product title', 3, 'title'),
      completenessCheck('description', 'Description', 2, 'description'),
      completenessCheck('price', 'Price', 3, 'price'),
      completenessCheck('image', 'Image', 2, 'image'),
      completenessCheck('sku', 'SKU / article number', 2, 'SKU'),
    ],
  };
  completeness.score = scoreOf(completeness.checks);

  /* --- Category 2: Content quality --- */

  const qualityChecks: Check[] = [];

  if (map.title) {
    const h = map.title;
    const bad: string[] = [];
    rows.forEach((r, i) => {
      const len = cell(r, h).length;
      if (len > 0 && (len < 10 || len > 150)) bad.push(rowLabel(r, i, map));
    });
    qualityChecks.push({
      id: 'title-length',
      label: 'Titles are a usable length',
      weight: 1,
      status: statusFromRatio(total - bad.length, total),
      examples: bad.slice(0, EX),
      detail:
        bad.length === 0
          ? 'All titles fall within a sensible 10–150 character range.'
          : `${plural(bad.length, 'title')} ${isAre(bad.length)} very short or very long (outside 10–150 characters).`,
      fix: 'Aim for descriptive 10–150 character titles: brand, product, key attribute. Marketplaces truncate the rest.',
    });
  }

  if (map.description) {
    const h = map.description;
    const thin: string[] = [];
    rows.forEach((r, i) => {
      const v = cell(r, h);
      if (v && wordCount(v) < 15) thin.push(rowLabel(r, i, map));
    });
    qualityChecks.push({
      id: 'description-depth',
      label: 'Descriptions are substantive',
      weight: 2,
      status: statusFromRatio(total - thin.length, total),
      examples: thin.slice(0, EX),
      detail:
        thin.length === 0
          ? 'Descriptions all carry a reasonable amount of text.'
          : `${plural(thin.length, 'description')} ${isAre(thin.length)} thin (under 15 words).`,
      fix: 'Write descriptions of real substance — they are what search and AI engines quote and rank.',
    });
  }

  if (map.price) {
    const h = map.price;
    const bad: string[] = [];
    rows.forEach((r, i) => {
      const v = cell(r, h);
      if (v) {
        const p = parsePrice(v);
        if (p === null || p <= 0) bad.push(rowLabel(r, i, map));
      }
    });
    qualityChecks.push({
      id: 'price-valid',
      label: 'Prices are valid numbers',
      weight: 2,
      status: statusFromRatio(total - bad.length, total),
      examples: bad.slice(0, EX),
      detail:
        bad.length === 0
          ? 'All non-empty prices parse as positive numbers.'
          : `${plural(bad.length, 'price')} ${isAre(bad.length)} zero, negative or not a number.`,
      fix: 'Store prices as clean decimal numbers. Malformed prices break feeds and get listings rejected.',
    });
  }

  if (map.image) {
    const h = map.image;
    const bad: string[] = [];
    rows.forEach((r, i) => {
      const v = cell(r, h);
      if (v && !/https?:\/\//i.test(v)) bad.push(rowLabel(r, i, map));
    });
    qualityChecks.push({
      id: 'image-valid',
      label: 'Image values are real URLs',
      weight: 1,
      status: statusFromRatio(total - bad.length, total),
      examples: bad.slice(0, EX),
      detail:
        bad.length === 0
          ? 'All non-empty image fields contain an http(s) URL.'
          : `${plural(bad.length, 'image field')} ${isAre(bad.length)} ${
              bad.length === 1
                ? 'a filename or path, not a full URL'
                : 'filenames or paths, not full URLs'
            }.`,
      fix: 'Use absolute https:// image URLs — most channels and feeds cannot resolve bare filenames.',
    });
  }

  const quality: Category = {
    id: 'quality',
    title: 'Content quality',
    blurb: 'Whether the data that exists is actually usable by channels and AI engines.',
    score: 0,
    checks: qualityChecks,
  };
  quality.score = scoreOf(quality.checks);

  /* --- Category 3: Consistency & identifiers --- */

  const consistencyChecks: Check[] = [];

  function duplicateCheck(
    field: CanonicalField,
    id: string,
    label: string,
    weight: number,
    noun: string,
  ): Check | null {
    const header = map[field];
    if (!header) return null;
    const seen = new Map<string, number>();
    rows.forEach((r) => {
      const v = cell(r, header).toLowerCase();
      if (v) seen.set(v, (seen.get(v) ?? 0) + 1);
    });
    const dups = [...seen.entries()].filter(([, n]) => n > 1);
    return {
      id,
      label,
      weight,
      status: dups.length === 0 ? 'pass' : dups.length <= total * 0.02 ? 'warn' : 'fail',
      examples: dups.slice(0, EX).map(([v, n]) => `${v} (×${n})`),
      detail:
        dups.length === 0
          ? `Every ${noun} is unique.`
          : `${plural(dups.length, noun + ' value')} ${isAre(dups.length)} shared by more than one product.`,
      fix: `Make every ${noun} unique. Duplicates cause channels to merge or reject listings.`,
    };
  }

  const dupSku = duplicateCheck('sku', 'duplicate-sku', 'SKUs are unique', 3, 'SKU');
  if (dupSku) consistencyChecks.push(dupSku);
  const dupTitle = duplicateCheck('title', 'duplicate-title', 'Titles are unique', 1, 'title');
  if (dupTitle) consistencyChecks.push(dupTitle);

  // Brand presence
  {
    const h = map.brand;
    if (!h) {
      consistencyChecks.push({
        id: 'brand',
        label: 'Brand is recorded',
        weight: 1,
        status: 'warn',
        examples: [],
        detail: 'No brand or manufacturer column was detected.',
        fix: 'Add a brand column — channels and AI engines use it to match and trust products.',
      });
    } else {
      const missing: string[] = [];
      rows.forEach((r, i) => {
        if (cell(r, h) === '') missing.push(rowLabel(r, i, map));
      });
      consistencyChecks.push({
        id: 'brand',
        label: 'Brand is recorded',
        weight: 1,
        status: statusFromRatio(total - missing.length, total),
        examples: missing.slice(0, EX),
        detail:
          missing.length === 0
            ? 'Every product has a brand.'
            : `${missing.length} of ${total} products have no brand (${pct(missing.length, total)}).`,
        fix: 'Fill in the brand for every product so listings can be matched and filtered.',
      });
    }
  }

  // GTIN / barcode presence
  {
    const h = map.gtin;
    if (!h) {
      consistencyChecks.push({
        id: 'gtin',
        label: 'GTIN / barcode is present',
        weight: 1,
        status: 'fail',
        examples: [],
        detail: 'No GTIN, EAN, UPC or barcode column was detected.',
        fix: 'Add a GTIN/EAN column. Google Shopping and most marketplaces need it to list products.',
      });
    } else {
      const missing: string[] = [];
      rows.forEach((r, i) => {
        if (cell(r, h) === '') missing.push(rowLabel(r, i, map));
      });
      consistencyChecks.push({
        id: 'gtin',
        label: 'GTIN / barcode is present',
        weight: 1,
        status: statusFromRatio(total - missing.length, total),
        examples: missing.slice(0, EX),
        detail:
          missing.length === 0
            ? 'Every product has a GTIN / barcode.'
            : `${missing.length} of ${total} products have no GTIN (${pct(missing.length, total)}).`,
        fix: 'Fill in GTIN/EAN values — listings without them are downranked or rejected by marketplaces.',
      });
    }
  }

  const consistency: Category = {
    id: 'consistency',
    title: 'Consistency & identifiers',
    blurb: 'Unique IDs and the identifiers channels need to list and match products.',
    score: 0,
    checks: consistencyChecks,
  };
  consistency.score = scoreOf(consistency.checks);

  /* --- Overall --- */

  const categories = [completeness, quality, consistency].filter((c) => c.checks.length > 0);
  const allChecks = categories.flatMap((c) => c.checks);
  const score = scoreOf(allChecks);
  const band: CatalogResult['band'] = score >= 75 ? 'strong' : score >= 50 ? 'fair' : 'weak';

  const failCount = allChecks.filter((c) => c.status === 'fail').length;
  const summary =
    band === 'strong'
      ? 'Solid catalog data. A few refinements would make it channel-ready everywhere.'
      : band === 'fair'
        ? `Workable, but ${failCount} issue(s) will cost you listings, ranking or conversions.`
        : `Significant data-quality gaps — ${failCount} issue(s) are actively holding this catalog back.`;

  const mapped = (Object.keys(map) as CanonicalField[]).filter((f) => map[f]);

  return {
    fileName,
    rowCount: total,
    columnCount: headers.length,
    mapped,
    unmapped,
    score,
    band,
    summary,
    categories,
  };
}
