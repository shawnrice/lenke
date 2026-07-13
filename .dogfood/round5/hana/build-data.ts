// Bitemporal HRIS data generator.
// Model:
//   (:Employee {eid, name, birthdate, hired})
//   (:Department {did, name})
//   (:Position {pid, title, level})
// Facts (effective-dated, bitemporal):
//   (:Assignment {aid, vfrom, vto, ttfrom, ttto})  -- valid-time + transaction-time
//     (Employee)-[:HAS_ASSIGNMENT]->(Assignment)-[:IN_DEPT]->(Department)
//     (Assignment)-[:AS_POSITION]->(Position)
//   (:Comp {cid, salary, currency, vfrom, vto, ttfrom, ttto})
//     (Employee)-[:HAS_COMP]->(Comp)
// vto/ttto == null means "open / still current".
import { Graph, parseDate, parseDateTime } from '@lenke/core';
import { query } from '@lenke/gql';

export function buildGraph(): Graph {
  const g = new Graph();

  const depts = [
    ['D1', 'Engineering'],
    ['D2', 'Sales'],
    ['D3', 'Marketing'],
    ['D4', 'Finance'],
    ['D5', 'People Ops'],
  ];
  const positions = [
    ['P1', 'Engineer I', 1],
    ['P2', 'Engineer II', 2],
    ['P3', 'Senior Engineer', 3],
    ['P4', 'Staff Engineer', 4],
    ['P5', 'Account Executive', 2],
    ['P6', 'Sales Manager', 3],
    ['P7', 'Marketing Specialist', 2],
    ['P8', 'Analyst', 2],
    ['P9', 'Manager', 3],
    ['P10', 'Director', 4],
  ];

  for (const [did, name] of depts) {
    g.addVertex({ labels: ['Department'], properties: { did, name } });
  }
  for (const [pid, title, level] of positions) {
    g.addVertex({ labels: ['Position'], properties: { pid, title, level } });
  }

  // Deterministic PRNG so results are reproducible.
  let seed = 42;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const pick = <T>(arr: T[]): T => arr[Math.floor(rnd() * arr.length)];
  const randInt = (a: number, b: number) => a + Math.floor(rnd() * (b - a + 1));

  const firsts = [
    'Priya',
    'Raj',
    'Elena',
    'Tomas',
    'Maya',
    'Sofia',
    'Liam',
    'Noah',
    'Ava',
    'Kai',
    'Wei',
    'Ines',
    'Omar',
    'Lena',
    'Diego',
    'Yuki',
    'Hana',
    'Nadia',
    'Ravi',
    'Chen',
  ];
  const lasts = [
    'Sharma',
    'Patel',
    'Ivanova',
    'Novak',
    'Chen',
    'Garcia',
    'Smith',
    'Kim',
    'Okafor',
    'Rossi',
    'Müller',
    'Haddad',
    'Nguyen',
    'Silva',
    'Tanaka',
    'Cohen',
    'Reyes',
    'Lund',
    'Diaz',
    'Wang',
  ];

  const N = 300;
  let aid = 0;
  let cid = 0;
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const isoDT = (d: Date) => d.toISOString().slice(0, 19);

  for (let i = 0; i < N; i++) {
    const eid = `E${String(i + 1).padStart(4, '0')}`;
    const name = `${pick(firsts)} ${pick(lasts)}`;
    // birthdate 1965..2001
    const birthYear = randInt(1965, 2001);
    const birthdate = iso(new Date(Date.UTC(birthYear, randInt(0, 11), randInt(1, 28))));
    // hire date 2015..2024
    const hireYear = randInt(2015, 2024);
    const hireMonth = randInt(0, 11);
    const hireDay = randInt(1, 28);
    const hired = iso(new Date(Date.UTC(hireYear, hireMonth, hireDay)));

    const emp = g.addVertex({ labels: ['Employee'], properties: { eid, name, birthdate, hired } });

    // Build a chain of assignments over time (1..4 roles).
    const nRoles = randInt(1, 4);
    let curDate = new Date(Date.UTC(hireYear, hireMonth, hireDay));
    const recorded = '2015-01-01T00:00:00'; // ttfrom for original records
    for (let r = 0; r < nRoles; r++) {
      const isLast = r === nRoles - 1;
      // each role lasts 8..30 months
      const next = new Date(curDate);
      next.setUTCMonth(next.getUTCMonth() + randInt(8, 30));
      const vfrom = iso(curDate);
      const vto = isLast ? null : iso(next);

      const dept = pick(depts);
      const pos = pick(positions);
      const aidStr = `A${String(++aid).padStart(5, '0')}`;
      const asg = g.addVertex({
        labels: ['Assignment'],
        properties: { aid: aidStr, vfrom, vto, ttfrom: recorded, ttto: null },
      });
      g.addEdge({ from: emp, to: asg, labels: ['HAS_ASSIGNMENT'], properties: {} });
      const deptV = [...g.getVerticesByLabel('Department')].find(
        (v) => v.getProperty('did') === dept[0],
      )!;
      const posV = [...g.getVerticesByLabel('Position')].find(
        (v) => v.getProperty('pid') === pos[0],
      )!;
      g.addEdge({ from: asg, to: deptV, labels: ['IN_DEPT'], properties: {} });
      g.addEdge({ from: asg, to: posV, labels: ['AS_POSITION'], properties: {} });

      // Comp fact aligned to the role, with a raise partway sometimes.
      const baseSalary = randInt(60, 220) * 1000;
      const cidStr = `C${String(++cid).padStart(5, '0')}`;
      g.addVertex({
        labels: ['Comp'],
        properties: {
          cid: cidStr,
          salary: baseSalary,
          currency: 'USD',
          vfrom,
          vto,
          ttfrom: recorded,
          ttto: null,
        },
      });
      const compV = [...g.getVerticesByLabel('Comp')].find((v) => v.getProperty('cid') === cidStr)!;
      g.addEdge({ from: emp, to: compV, labels: ['HAS_COMP'], properties: {} });

      curDate = next;
    }
  }

  // Replace the first employee with a deterministic, hand-built anchor: Priya
  // Sharma, with a KNOWN bitemporal history so narrative queries are verifiable.
  const anchor = [...g.getVerticesByLabel('Employee')][0];
  for (const e of [...anchor.edgesFromByLabel('HAS_ASSIGNMENT')]) g.removeVertex(e.to);
  for (const e of [...anchor.edgesFromByLabel('HAS_COMP')]) g.removeVertex(e.to);
  anchor.setProperties({ name: 'Priya Sharma', birthdate: '1990-03-15', hired: '2019-02-01' });

  const deptV = (did: string) =>
    [...g.getVerticesByLabel('Department')].find((v) => v.getProperty('did') === did)!;
  const posV = (pid: string) =>
    [...g.getVerticesByLabel('Position')].find((v) => v.getProperty('pid') === pid)!;

  // Priya's valid-time role history (stored as REAL DATE values, ttfrom DATETIME).
  // 2019-02-01 -> 2021-01-01 Engineer II  (Engineering)
  // 2021-01-01 -> 2023-09-01 Senior Eng   (Engineering)   <- as-of 2023-06-01 here
  // 2023-09-01 -> open       Staff Eng    (Engineering)
  const roles: [string, string | null, string, string][] = [
    ['2019-02-01', '2021-01-01', 'D1', 'P2'],
    ['2021-01-01', '2023-09-01', 'D1', 'P3'],
    ['2023-09-01', null, 'D1', 'P4'],
  ];
  let ai = aid;
  for (const [vfrom, vto, did, pid] of roles) {
    const aidStr = `A${String(++ai).padStart(5, '0')}`;
    const asg = g.addVertex({ labels: ['Assignment'], properties: { aid: aidStr, ttto: null } });
    asg.setProperty('vfrom', parseDate(vfrom));
    asg.setProperty('vto', vto === null ? null : parseDate(vto));
    asg.setProperty('ttfrom', parseDateTime('2019-01-01T00:00:00'));
    g.addEdge({ from: anchor, to: asg, labels: ['HAS_ASSIGNMENT'], properties: {} });
    g.addEdge({ from: asg, to: deptV(did), labels: ['IN_DEPT'], properties: {} });
    g.addEdge({ from: asg, to: posV(pid), labels: ['AS_POSITION'], properties: {} });
  }

  // Priya's comp history. The salary for 2021-01-01..2023-09-01 was recorded as
  // 150000 but a CORRECTION on 2024-06-01 fixes it to 158000 (bitemporal: close
  // the old fact's ttto, insert a new fact with same valid interval + later ttfrom).
  const comps: [string, string | null, number, string, string | null][] = [
    ['2019-02-01', '2021-01-01', 120000, '2019-01-01T00:00:00', null],
    ['2021-01-01', '2023-09-01', 150000, '2019-01-01T00:00:00', '2024-06-01T00:00:00'],
    ['2023-09-01', null, 185000, '2019-01-01T00:00:00', null],
    ['2021-01-01', '2023-09-01', 158000, '2024-06-01T00:00:00', null],
  ];
  let ci = cid;
  for (const [vfrom, vto, salary, ttfrom, ttto] of comps) {
    const cidStr = `C${String(++ci).padStart(5, '0')}`;
    const c = g.addVertex({
      labels: ['Comp'],
      properties: { cid: cidStr, salary, currency: 'USD' },
    });
    c.setProperty('vfrom', parseDate(vfrom));
    c.setProperty('vto', vto === null ? null : parseDate(vto));
    c.setProperty('ttfrom', parseDateTime(ttfrom));
    c.setProperty('ttto', ttto === null ? null : parseDateTime(ttto));
    g.addEdge({ from: anchor, to: c, labels: ['HAS_COMP'], properties: {} });
  }

  return g;
}

if (import.meta.main) {
  const g = buildGraph();
  console.log('Employees:', g.getVerticesByLabel('Employee').size);
  console.log('Assignments:', g.getVerticesByLabel('Assignment').size);
  console.log('Comps:', g.getVerticesByLabel('Comp').size);
  console.log('Depts:', g.getVerticesByLabel('Department').size);
  const sample = query(
    g,
    `MATCH (e:Employee)-[:HAS_ASSIGNMENT]->(a:Assignment)-[:IN_DEPT]->(d:Department)
    WHERE e.name = 'Priya Sharma' RETURN e.name AS name, a.vfrom AS vfrom, a.vto AS vto, d.name AS dept ORDER BY a.vfrom`,
  );
  console.log('Priya assignments:', sample);
}
