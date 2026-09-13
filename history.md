# jsonstor-leveldb
[`@liquicode/jsonstor-leveldb`](https://github.com/liquicode/jsonstor-leveldb)


# Project History


v0.2.0 (current)
---------------------------------------------------------------------

***First release.***

The adapter for LevelDB, a local key-value store. It keeps an index over the primary key, so
  a criteria naming one identifier reads one document.

- Built on `@liquicode/jsonstor` 0.2.0 and `@liquicode/jsongin` 0.2.0. A criteria the engine
  refuses is refused before the storage acts on it.
- Declares Node.js `>=18.0.0` in `engines`.
