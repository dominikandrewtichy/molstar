# Mol* Query Language (MolQL)

MolQL is a domain-specific, functional language designed for querying and manipulating molecular structure data within Mol*. It provides a unified intermediate representation (IR) that allows queries to be written in various source languages (like PyMOL or VMD selection syntax) and compiled into efficient JavaScript execution functions.

## Architecture

The MolQL system is divided into three main layers:

1.  **Language (AST)**: A serializable Abstract Syntax Tree representing the query.
2.  **Transpilers**: Modules that convert other selection languages into MolQL AST.
3.  **Runtime**: The execution engine that compiles the AST into efficient JavaScript functions.

## 1. Language (AST)

The core of MolQL is the `Expression` type, which mimics Lisp-like S-expressions. An expression can be:

-   **Literal**: A primitive value (string, number, boolean).
-   **Symbol**: A named reference to a standard function or constant (e.g., `structure-query.generator.atom-groups`).
-   **Apply**: A function call, consisting of a `head` (the function symbol) and `args` (arguments).

This structure makes the queries easy to serialize (as JSON) and traverse.

### Example AST (JSON)

```json
{
  "head": "structure-query.combinator.merge",
  "args": [
    { "head": "structure-query.generator.atom-groups", "args": { ... } }
  ]
}
```

## 2. Runtime

The runtime (`src/mol-script/runtime`) is responsible for executing the queries.

-   **Compiler**: Converts an `Expression` into a `QueryFn`.
-   **QueryFn**: A function that takes a `QueryContext` (containing the structure data) and returns a `StructureSelection`.
-   **Runtime Table**: A registry that maps AST `Symbols` to their actual JavaScript implementations.

## 3. Transpilers

Located in `src/mol-script/transpilers`, these modules allow users to write queries in familiar syntaxes. Mol* currently supports transpilers for:

-   **PyMOL**
-   **VMD**
-   **Jmol**

Example:
```typescript
import { transpile } from 'mol-script/transpilers/pymol/parser';
const ast = transpile('resn ALA and chain A');
```

## Structure Selection

The primary use case for MolQL is selecting atoms. The language defines several categories of symbols for this purpose:

### Generators
Functions that produce an initial set of atoms based on properties.
-   `atom-groups`: Selects atoms based on hierarchy (residue name, chain ID, etc.).
-   `all`: Selects everything.
-   `empty`: Selects nothing.

### Modifiers
Functions that take a selection and alter it.
-   `include-surroundings`: Expands the selection to include atoms within a radius.
-   `expand-property`: Expands selection based on connectivity or other properties.

### Combinators
Functions that combine multiple selections.
-   `merge` (OR): Union of selections.
-   `intersect` (AND): Intersection of selections.

### Filters
Predicates used within generators to refine the match.
-   `pick`: Selects based on a test function.
