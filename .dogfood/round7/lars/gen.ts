// Deterministic messy-data generator with planted ground truth.
// Produces two sources: crm.csv (plain business CSV: id,name,email,phone,city,updated)
// and erp.ndjson. Each source record carries a hidden `truth` cluster id so we can
// measure precision/recall of the matcher. Variations planted: case, whitespace,
// email case, phone formatting, name order (Last, First), and single-char typos.

// -- tiny seeded PRNG (mulberry32) so runs are reproducible --
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FIRST = [
  'John',
  'Jane',
  'Robert',
  'Maria',
  'James',
  'Linda',
  'Michael',
  'Sarah',
  'David',
  'Emily',
  'Daniel',
  'Laura',
  'Thomas',
  'Nancy',
  'Paul',
  'Karen',
  'Mark',
  'Lisa',
  'Steven',
  'Anna',
];
const LAST = [
  'Smith',
  'Johnson',
  'Williams',
  'Brown',
  'Jones',
  'Garcia',
  'Miller',
  'Davis',
  'Rodriguez',
  'Martinez',
  'Hernandez',
  'Lopez',
  'Gonzalez',
  'Wilson',
  'Anderson',
  'Thomas',
  'Taylor',
  'Moore',
  'Jackson',
  'Martin',
];
const CITY = ['Austin', 'Denver', 'Boston', 'Seattle', 'Miami', 'Chicago', 'Portland', 'Dallas'];
const DOMAIN = ['acme.com', 'globex.com', 'initech.io', 'umbrella.co', 'stark.com'];

export type SrcRec = {
  id: string;
  source: string;
  truth: number; // ground-truth cluster id
  name: string;
  email: string;
  phone: string;
  city: string;
  updated: string; // ISO date
};

function pick<T>(r: () => number, arr: T[]): T {
  return arr[Math.floor(r() * arr.length)];
}

function typo(r: () => number, s: string): string {
  if (s.length < 3) return s;
  const i = 1 + Math.floor(r() * (s.length - 2));
  // swap two adjacent chars (common real-world typo)
  return s.slice(0, i) + s[i + 1] + s[i] + s.slice(i + 2);
}

function fmtPhone(r: () => number, digits: string): string {
  const a = digits.slice(0, 3),
    b = digits.slice(3, 6),
    c = digits.slice(6);
  switch (Math.floor(r() * 5)) {
    case 0:
      return `(${a}) ${b}-${c}`;
    case 1:
      return `${a}-${b}-${c}`;
    case 2:
      return digits;
    case 3:
      return `+1 ${a} ${b} ${c}`;
    default:
      return `${a}.${b}.${c}`;
  }
}

function vary(r: () => number, first: string, last: string): string {
  const full = `${first} ${last}`;
  switch (Math.floor(r() * 6)) {
    case 0:
      return full;
    case 1:
      return full.toUpperCase();
    case 2:
      return full.toLowerCase();
    case 3:
      return `  ${first}   ${last} `; // extra whitespace
    case 4:
      return `${last}, ${first}`; // last-first order
    default:
      return ` ${first} ${last}`;
  }
}

export type Gen = {
  records: SrcRec[];
  clusters: Map<number, string[]>; // truth id -> member record ids
};

export function generate(numEntities = 1200, seed = 42): Gen {
  const r = rng(seed);
  const records: SrcRec[] = [];
  const clusters = new Map<number, string[]>();
  let sid = 0;

  for (let t = 0; t < numEntities; t++) {
    const first = pick(r, FIRST);
    const last = pick(r, LAST);
    const domain = pick(r, DOMAIN);
    const city = pick(r, CITY);
    // per-entity UNIQUE phone + email (real people rarely share these exactly);
    // duplicates of the same entity share them, distinct entities differ by `t`.
    const digits = String(2000000000 + t * 6389).slice(0, 10);
    const emailUser = `${first}.${last}${t}`.toLowerCase();
    const canonicalEmail = `${emailUser}@${domain}`;

    const nDupes = 1 + Math.floor(r() * 3); // 1..3 duplicates
    const members: string[] = [];
    for (let d = 0; d < nDupes; d++) {
      const id = `R${sid++}`;
      const source = r() < 0.5 ? 'crm' : 'erp';
      // email variations: case + occasional dotless / plus-tag
      let email = canonicalEmail;
      if (r() < 0.4) email = email.toUpperCase();
      else if (r() < 0.2) email = `${first}${last}${t}@${domain}`.toLowerCase();
      // "hard" duplicate: typo in name AND a fresh phone/email so ONLY fuzzy would catch it
      let name = vary(r, first, last);
      let phone = fmtPhone(r, digits);
      if (d > 0 && r() < 0.15) {
        name = typo(r, `${first} ${last}`);
        phone = fmtPhone(r, String(3000000000 + Math.floor(r() * 6999999999)).slice(0, 10));
        email = `${emailUser}${d}@${domain}`; // different email -> unlinkable w/o fuzzy
      }
      const y = 2020 + Math.floor(r() * 6);
      const m = 1 + Math.floor(r() * 12);
      const day = 1 + Math.floor(r() * 28);
      const updated = `${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      // survivorship: some records missing city/phone (sparse) to test "most complete"
      const rec: SrcRec = {
        id,
        source,
        truth: t,
        name,
        email,
        phone: r() < 0.15 ? '' : phone,
        city: r() < 0.2 ? '' : city,
        updated,
      };
      records.push(rec);
      members.push(id);
    }
    clusters.set(t, members);
  }
  return { records, clusters };
}
