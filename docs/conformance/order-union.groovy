g = TinkerFactory.createModern().traversal()

// Each line is printed with its own try/catch so one fault does not end the script.
// NOTE: no named closures — the REPL cannot call one (tinkerpop-ground-truth-harness).

println "--- 1 order() over VERTICES, nothing else"
try { println "  " + g.V().order().toList() } catch (Throwable t) { println "  ERR " + t.getClass().getSimpleName() + ": " + t.getMessage() }

println "--- 2 order() over an EMPTY vertex stream"
try { println "  " + g.V().out('nope').order().toList() } catch (Throwable t) { println "  ERR " + t.getClass().getSimpleName() + ": " + t.getMessage() }

println "--- 3 union of two arms then order()  [the reduced shape]"
try { println "  " + g.V().union(__.has('name', P.gt('nope')).out('knows','nope'), __.out('nope')).order().toList() } catch (Throwable t) { println "  ERR " + t.getClass().getSimpleName() + ": " + t.getMessage() }

println "--- 4 the FULL traversal: union, order, skip(1), inE, values"
try { println "  " + g.V().union(__.has('name', P.gt('nope')).out('knows','nope'), __.out('nope')).order().skip(1).inE('knows').values('weight').toList() } catch (Throwable t) { println "  ERR " + t.getClass().getSimpleName() + ": " + t.getMessage() }

println "--- 5 order() then the same tail, NO union"
try { println "  " + g.V().order().skip(1).inE('knows').values('weight').toList() } catch (Throwable t) { println "  ERR " + t.getClass().getSimpleName() + ": " + t.getMessage() }

println "--- 6 how many rows reach the order in case 3/4?"
try { println "  " + g.V().union(__.has('name', P.gt('nope')).out('knows','nope'), __.out('nope')).count().toList() } catch (Throwable t) { println "  ERR " + t.getClass().getSimpleName() + ": " + t.getMessage() }

println "--- 7 order() over a MIXED stream (vertex + number), which cannot compare"
try { println "  " + g.V().limit(1).union(__.identity(), __.values('age')).order().toList() } catch (Throwable t) { println "  ERR " + t.getClass().getSimpleName() + ": " + t.getMessage() }
