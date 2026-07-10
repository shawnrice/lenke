import { Graph, type Vertex } from '@lenke/core';
import { createTestTinkerGraph } from '@lenke/gremlin';

// The built-in graphs the explorer can load without a file. The point of more
// than one is to have something richer than the 6-node TinkerPop toy: the
// Movies graph has three vertex labels (Person, Movie, Genre) and three edge
// types (ACTED_IN, DIRECTED, IN_GENRE), so the schema panel and multi-variable
// queries (`MATCH (p:Person)-[:ACTED_IN]->(m:Movie) RETURN p, m`) have
// something to chew on.
export type Sample = { name: string; build: () => Graph };

const movies = (): Graph => {
  const g = new Graph();
  const person = (name: string, born: number): Vertex =>
    g.addVertex({ labels: ['Person'], properties: { name, born } });
  const movie = (title: string, year: number, rating: number): Vertex =>
    // `name` mirrors `title` so the canvas labels read nicely (it renders `name`).
    g.addVertex({ labels: ['Movie'], properties: { name: title, title, year, rating } });
  const genre = (name: string): Vertex => g.addVertex({ labels: ['Genre'], properties: { name } });

  const keanu = person('Keanu Reeves', 1964);
  const carrie = person('Carrie-Anne Moss', 1967);
  const laurence = person('Laurence Fishburne', 1961);
  const hugo = person('Hugo Weaving', 1960);
  const lana = person('Lana Wachowski', 1965);
  const lilly = person('Lilly Wachowski', 1967);
  const emil = person('Emil Eifrem', 1978);
  const charlize = person('Charlize Theron', 1975);
  const al = person('Al Pacino', 1940);
  const taylor = person('Taylor Hackford', 1944);

  const matrix = movie('The Matrix', 1999, 8.7);
  const reloaded = movie('The Matrix Reloaded', 2003, 7.2);
  const revolutions = movie('The Matrix Revolutions', 2003, 6.7);
  const devil = movie("The Devil's Advocate", 1997, 7.5);

  const scifi = genre('Sci-Fi');
  const action = genre('Action');
  const drama = genre('Drama');
  const thriller = genre('Thriller');

  const actedIn = (p: Vertex, m: Vertex, role: string): void => {
    g.addEdge({ from: p, to: m, labels: ['ACTED_IN'], properties: { role } });
  };
  const directed = (p: Vertex, m: Vertex): void => {
    g.addEdge({ from: p, to: m, labels: ['DIRECTED'], properties: {} });
  };
  const inGenre = (m: Vertex, gv: Vertex): void => {
    g.addEdge({ from: m, to: gv, labels: ['IN_GENRE'], properties: {} });
  };

  for (const m of [matrix, reloaded, revolutions]) {
    actedIn(keanu, m, 'Neo');
    actedIn(carrie, m, 'Trinity');
    actedIn(laurence, m, 'Morpheus');
    actedIn(hugo, m, 'Agent Smith');
    directed(lana, m);
    directed(lilly, m);
    inGenre(m, scifi);
    inGenre(m, action);
  }

  actedIn(emil, matrix, 'Emil');
  actedIn(keanu, devil, 'Kevin Lomax');
  actedIn(charlize, devil, 'Mary Ann Lomax');
  actedIn(al, devil, 'John Milton');
  directed(taylor, devil);
  inGenre(devil, drama);
  inGenre(devil, thriller);

  return g;
};

export const SAMPLES: readonly Sample[] = [
  { name: 'TinkerPop', build: createTestTinkerGraph },
  { name: 'Movies', build: movies },
];
