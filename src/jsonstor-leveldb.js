'use strict';

const jsongin = require( '@liquicode/jsongin' );
const { ClassicLevel } = require( 'classic-level' );
const DRIVER_PACKAGE = require( 'classic-level/package.json' );


//---------------------------------------------------------------------
// ***The byte which separates a collection name from a document key.***
//
// A LevelDB keyspace is flat and ordered, so a collection is a key range rather than a
// container: every key begins `<CollectionName><SEPARATOR>`, and the range ends at the next
// byte up. That is why the terminator is one greater than the separator rather than some
// sentinel string - `\x02` is the first key which cannot belong to this collection, whatever
// the document keys turn out to be.
//
// ***Neither byte can appear in a collection name***, which is checked rather than assumed.
const SEPARATOR = String.fromCharCode( 1 );
const TERMINATOR = String.fromCharCode( 2 );


//---------------------------------------------------------------------
// ***The index lives in the same store, in a range which sorts below every document key.***
//
// A document key begins with the padded clock, so its first byte is always a digit. An index
// key begins with \x00, which is lower than every digit - so the document scan keeps a single
// range bound and skips the index without knowing anything about it, and ***an existing store
// needs no migration because no document key changes.***
//
// ***This is why the clock key survives.*** Keying documents by the identifier instead would
// have bought uniqueness and spent the natural order: LevelDB's iteration order is its key
// order, and every ordered read would then have to fetch values and sort them. The wave 2 plan
// recorded that trade before this adapter was written. An index buys the same uniqueness and
// spends a second write per insert instead.
const INDEX_MARKER = String.fromCharCode( 0 );

// The lowest byte a document key may begin with. Numerically the separator, and a different
// idea: it is the floor of the document range rather than a delimiter, and it is what puts the
// index keys underneath it.
const DOCUMENT_KEY_FLOOR = String.fromCharCode( 1 );


//---------------------------------------------------------------------
// ***One open store per path, shared by every storage which names that path.***
//
// LevelDB takes an exclusive lock on its directory, so a second store opened on a path
// another store already holds is refused - measured on 2026-09-02, which is what turned this
// from an optimization into a requirement. A storage is one collection and a path holds many,
// so two storages naming one path is the ordinary case rather than the exceptional one.
//
// ***Keyed by path and memoized as a promise***, which is the shape `jsonstor-mysql`,
// `-oracle` and `-duckdb` already use for a held connection: concurrent callers await the same
// open rather than racing to start a second one. ***A failed open is forgotten***, so a storage
// pointed at a path which cannot be opened fails every time it is asked rather than once - the
// defect `004) Unreachable Storage Tests` exists to catch.
const OPEN_STORES = {};


//---------------------------------------------------------------------
// ***A counter which makes a key unique inside one process.***
//
// The key carries the document's position in the natural order and is built from the clock, so
// two documents written in the same nanosecond would otherwise collide - and a colliding key
// silently replaces a document rather than failing. `jsonstor-folder` has the same exposure in
// its file names; this costs one field to close it.
let key_sequence = 0;


module.exports = {

	AdapterName: 'jsonstor-leveldb',
	AdapterDescription: 'Documents are stored in a LevelDB store.',

	GetAdapter: function ( jsonstor, Settings )
	{


		//=====================================================================
		/*
			Settings = {
				Path: '',            // The folder holding the LevelDB store. Created if absent.
				CollectionName: '',  // The key prefix documents of this storage are stored under.
			}
		*/
		if ( jsongin.ShortType( Settings ) !== 'o' ) { throw new Error( `This adapter requires a Settings parameter.` ); }
		if ( jsongin.ShortType( Settings.Path ) !== 's' ) { throw new Error( `This adapter requires a Settings.Path string parameter.` ); }
		if ( jsongin.ShortType( Settings.CollectionName ) !== 's' ) { throw new Error( `This adapter requires a Settings.CollectionName string parameter.` ); }
		if ( !Settings.CollectionName.length ) { throw new Error( `Settings.CollectionName cannot be empty.` ); }
		// ***A collection name carrying either byte would redraw its own range.*** A name holding
		// the separator could reach into a neighbour's keys, and one holding the terminator would
		// sort past the end of its own range and read back as empty.
		if ( Settings.CollectionName.includes( SEPARATOR ) || Settings.CollectionName.includes( TERMINATOR ) )
		{
			throw new Error( `Settings.CollectionName cannot contain character 1 or character 2.` );
		}


		//=====================================================================
		let Storage = jsonstor.StorageInterface();
		Storage.Settings = jsongin.Clone( Settings );


		//=====================================================================
		// The key, resolved.
		let key_declaration = jsonstor.PrimaryKey.Resolve( Storage.Settings );
		if ( key_declaration.Fields.length > 1 )
		{
			// ***Declared, not built.*** One index key holds one encoded value, so an adapter
			// which cannot honor a composite key refuses it by name.
			throw new Error( `This adapter does not support a composite PrimaryKey: [${key_declaration.Fields.join( ', ' )}].` );
		}
		if ( key_declaration.Fields.length === 0 ) { key_declaration.Fields = [ jsonstor.PrimaryKey.DEFAULT_FIELD ]; }

		Storage.PrimaryKeyInfo = {
			Fields: key_declaration.Fields,
			// The store's own key is the clock, not the identifier, so there is no key column
			// whose type would need declaring. The index key carries the encoded value and the
			// document carries the true one.
			Types: [],
			Mutable: key_declaration.Mutable,
			Generated: true,
			// ***jsonstor holds this index, even though it lives in the database.*** LevelDB has
			// no secondary indexes of its own; every entry here is written and maintained by this
			// adapter, which is what makes RefreshIndex real work rather than a no-op.
			IndexHostedBy: 'jsonstor',
		};


		//=====================================================================
		// What the two stages did, for a storage which has no first stage.
		//
		// ***This adapter pushes nothing down, and that is the measurement.*** LevelDB has no
		// query language, so there is no clause to build: every document in the collection is
		// handed to jsongin and the criteria is the residual entire. Reporting it makes this
		// comparable with an adapter which does push down - PushdownRows reads the same way
		// everywhere: how many rows the second stage had to look at.
		//
		// Scanned is the size of the collection rather than the number of documents actually
		// examined, because a read which stops early stopped by luck rather than by a clause.
		function report_scan( Options, Criteria, Scanned, Matched )
		{
			jsonstor.ReportStatistics( Options, {
				Translator: '',
				Pushdown: null,
				PushdownRows: Scanned,
				Residual: ( jsongin.ShortType( Criteria ) === 'o' ) ? Criteria : {},
				ResidualRows: Matched,
			} );
			return;
		}


		//=====================================================================
		// What the index did.
		//
		// ***An index is a pushdown for an adapter with no server to push down to***, so it
		// reports in the same pair of numbers a WHERE clause does. PushdownRows is one or zero
		// rather than the size of the collection, and that difference is the whole assertion: an
		// index which is never entered reports the collection and looks exactly like no index.
		function report_lookup( Options, Criteria, Scanned, Matched )
		{
			jsonstor.ReportStatistics( Options, {
				Translator: '',
				Pushdown: Criteria,
				PushdownRows: Scanned,
				Residual: {},
				ResidualRows: Matched,
			} );
			return;
		}


		//=====================================================================
		// The store, opened once per path and shared.
		//=====================================================================


		//---------------------------------------------------------------------
		async function held_store()
		{
			let path = Storage.Settings.Path;
			if ( typeof OPEN_STORES[ path ] === 'undefined' )
			{
				let store = new ClassicLevel( path, { valueEncoding: 'utf8' } );
				OPEN_STORES[ path ] = store.open().then(
					function ()
					{
						return store;
					},
					function ( OpenError )
					{
						// ***Forgotten, so the next call tries again and fails again.*** A
						// remembered failure would answer an empty collection for the life of
						// the process, which is a plausible answer rather than a failure.
						delete OPEN_STORES[ path ];
						throw OpenError;
					} );
			}
			return await OPEN_STORES[ path ];
		}


		//---------------------------------------------------------------------
		// The half-open key range holding exactly this collection's documents.
		//
		// ***The floor is what excludes the index.*** Every index key sorts below it, so a scan
		// which asks for documents never sees one and never has to filter for it.
		function collection_range()
		{
			return {
				gte: Storage.Settings.CollectionName + SEPARATOR + DOCUMENT_KEY_FLOOR,
				lt: Storage.Settings.CollectionName + TERMINATOR,
			};
		}


		//---------------------------------------------------------------------
		// Everything this collection owns: its documents and its index.
		function everything_range()
		{
			return {
				gte: Storage.Settings.CollectionName + SEPARATOR,
				lt: Storage.Settings.CollectionName + TERMINATOR,
			};
		}


		//---------------------------------------------------------------------
		// The half-open key range holding exactly this collection's index.
		function index_range()
		{
			return {
				gte: Storage.Settings.CollectionName + SEPARATOR + INDEX_MARKER,
				lt: Storage.Settings.CollectionName + SEPARATOR + DOCUMENT_KEY_FLOOR,
			};
		}


		//---------------------------------------------------------------------
		// The index key filing this encoded identifier.
		function index_key( EncodedKey )
		{
			return Storage.Settings.CollectionName + SEPARATOR + INDEX_MARKER + EncodedKey;
		}


		//---------------------------------------------------------------------
		// ***The one key which records that a lookup can no longer be trusted.***
		//
		// jsongin matches `{ _id: 'x' }` against a document whose identifier is `[ 'x' ]`, by the
		// array element rule every operator obeys - so an index filed under the array cannot
		// answer that criteria. A collection holding one must be scanned instead.
		//
		// An in-memory adapter keeps this as a boolean; a store which outlives the process cannot,
		// so it is a key. The encoded value of a real identifier is never empty - it always
		// carries its short type and a colon - so nothing else can land here.
		function complex_key_sentinel()
		{
			return Storage.Settings.CollectionName + SEPARATOR + INDEX_MARKER;
		}


		//---------------------------------------------------------------------
		// The encoded identifier a document carries, or null when it carries none.
		function document_key_of( Document )
		{
			return jsonstor.PrimaryKey.DocumentKey( Document, Storage.PrimaryKeyInfo.Fields );
		}


		//---------------------------------------------------------------------
		// Mints an identifier for a document which arrived without one.
		function apply_new_key( Document )
		{
			let field = Storage.PrimaryKeyInfo.Fields[ 0 ];
			let value = jsongin.GetValue( Document, field );
			if ( typeof value !== 'undefined' ) { return; }
			jsongin.SetValue( Document, field, jsonstor.NewUniqueID() );
			return;
		}


		//---------------------------------------------------------------------
		// A value LevelDB answers, or undefined when the key is not there.
		async function get_or_undefined( Store, Key )
		{
			// classic-level answers undefined for a missing key rather than throwing, but an
			// older abstract-level threw LEVEL_NOT_FOUND and this costs nothing to survive.
			try { return await Store.get( Key ); }
			catch ( error )
			{
				if ( error && ( error.code === 'LEVEL_NOT_FOUND' ) ) { return undefined; }
				throw error;
			}
		}


		//---------------------------------------------------------------------
		// Refuses an identifier which is already in the collection.
		//
		// ***One point read rather than a scan***, which is the whole reason the index is here.
		async function require_unique( Store, EncodedKey, ExceptDocumentKey )
		{
			if ( EncodedKey === null ) { return; }
			let found = await get_or_undefined( Store, index_key( EncodedKey ) );
			if ( typeof found === 'undefined' ) { return; }
			if ( found === ExceptDocumentKey ) { return; }
			throw new Error( `A document with this primary key already exists: ${ EncodedKey }.` );
		}


		//---------------------------------------------------------------------
		// Refuses an update or a replace which moved the identifier. See
		// jsonx/.plans/primary-keys-and-indexes.md - refusing is the only one of the three
		// measured behaviors which cannot mislead a caller.
		function check_key_move( Before, After )
		{
			if ( Storage.PrimaryKeyInfo.Mutable ) { return; }
			if ( Before === After ) { return; }
			throw new Error( `The primary key [${Storage.PrimaryKeyInfo.Fields[ 0 ]}] is not mutable, and this operation would change it from [${Before}] to [${After}].` );
		}


		//---------------------------------------------------------------------
		// The batch operations which file a document in the index.
		function index_writes( Document, DocumentKey )
		{
			let operations = [];
			let value = jsonstor.PrimaryKey.DocumentValue( Document, Storage.PrimaryKeyInfo.Fields );
			if ( value === null ) { return operations; }
			operations.push( { type: 'put', key: index_key( jsonstor.PrimaryKey.EncodeValue( value ) ), value: DocumentKey } );
			if ( !jsonstor.PrimaryKey.IsScalar( value ) )
			{
				operations.push( { type: 'put', key: complex_key_sentinel(), value: '1' } );
			}
			return operations;
		}


		//---------------------------------------------------------------------
		// ***The document a by-key criteria asks for, or null to ask the scan.***
		//
		// Two point reads and no iteration: the index answers the document key, and the store
		// answers the document. A miss is only trustworthy while every identifier in the
		// collection is a scalar, which is what the sentinel records.
		async function find_by_index( Criteria )
		{
			let encoded = jsonstor.PrimaryKey.CriteriaKey( Criteria, Storage.PrimaryKeyInfo.Fields );
			if ( encoded === null ) { return null; }
			let store = await held_store();

			// ***The sentinel is read before the index and not after a miss.***
			// A hit is just as wrong as a miss once the collection holds a non-scalar identifier:
			// { _id: 'x' } matches a document whose identifier is [ 'x' ] as well as the one
			// whose identifier is 'x', so answering with the hit alone ***loses a row and reports
			// success***. Checking only the miss was the first version of this function and it was
			// caught by the two-document case it exists for.
			let sentinel = await get_or_undefined( store, complex_key_sentinel() );
			if ( typeof sentinel !== 'undefined' ) { return null; }

			let document_key = await get_or_undefined( store, index_key( encoded ) );
			if ( typeof document_key === 'undefined' ) { return { Entries: [] }; }
			let value = await get_or_undefined( store, document_key );
			if ( typeof value === 'undefined' )
			{
				// ***An index entry with no document behind it.*** Nothing this adapter writes
				// can produce one, so it means the store was written by something else. Falling
				// through to the scan is the answer which cannot lose a row.
				return null;
			}
			return { Entries: [ { Key: document_key, Document: JSON.parse( value ) } ] };
		}


		//---------------------------------------------------------------------
		// ***A key which sorts in insertion order***, which is this storage's natural order.
		//
		// Every component is padded to a fixed width, because a variable width field sorts
		// lexicographically in a different order than it was written in - '9000000' lands after
		// '564003000'. That is the same trap `jsonstor-folder` documents in its file names, and
		// it is the same fix.
		function new_document_key()
		{
			let hr_time = process.hrtime();
			let milliseconds = String( ( new Date() ).getTime() ).padStart( 14, '0' );
			let hr_seconds = String( hr_time[ 0 ] ).padStart( 10, '0' );
			let hr_nanoseconds = String( hr_time[ 1 ] ).padStart( 9, '0' );
			key_sequence = ( key_sequence + 1 ) % 1000000;
			let sequence = String( key_sequence ).padStart( 6, '0' );
			return Storage.Settings.CollectionName + SEPARATOR
				+ `${milliseconds}.${hr_seconds}.${hr_nanoseconds}.${sequence}`;
		}


		//---------------------------------------------------------------------
		// ***How many documents this collection holds, without reading one.***
		//
		// A keys-only iterator never fetches a value, so the size of a collection costs the
		// keys and nothing else. That is what lets the single-document reads below stop at
		// their first match and still report an honest Scanned - the count is taken separately
		// rather than inferred from how far the match happened to be.
		async function count_documents()
		{
			let store = await held_store();
			let counted = 0;
			for await ( const ignored_key of store.keys( collection_range() ) )
			{
				counted++;
			}
			return counted;
		}


		//---------------------------------------------------------------------
		// Every document in the collection, in natural order, with the key it is stored under.
		async function read_documents()
		{
			let store = await held_store();
			let entries = [];
			for await ( const [ key, value ] of store.iterator( collection_range() ) )
			{
				entries.push( { Key: key, Document: JSON.parse( value ) } );
			}
			return entries;
		}


		//---------------------------------------------------------------------
		// ***The first document satisfying Criteria, and the key holding it.***
		//
		// Stops at the match. An empty, null or undefined criteria matches the first document
		// in the collection, which is what every sibling adapter answers.
		async function find_first( Criteria )
		{
			let store = await held_store();
			let matches_everything = criteria_matches_everything( Criteria );
			for await ( const [ key, value ] of store.iterator( collection_range() ) )
			{
				let document = JSON.parse( value );
				if ( matches_everything || jsongin.Query( document, Criteria ) )
				{
					return { Key: key, Document: document };
				}
			}
			return null;
		}


		//---------------------------------------------------------------------
		// null, undefined and {} all mean "every document".
		function criteria_matches_everything( Criteria )
		{
			let short_type = jsongin.ShortType( Criteria );
			if ( 'lu'.includes( short_type ) ) { return true; }
			if ( Object.keys( Criteria ).length === 0 ) { return true; }
			return false;
		}


		//---------------------------------------------------------------------
		// Criteria this storage will accept at all.
		function check_criteria( Criteria )
		{
			let short_type = jsongin.ShortType( Criteria );
			if ( !'olu'.includes( short_type ) ) { throw new Error( `Criteria must be an object, null, or undefined.` ); }
			return;
		}


		//=====================================================================
		// StorageInfo
		//=====================================================================


		// ***What this storage is actually talking to.***
		//
		// LevelDB itself reports no version through this binding, so the version carried here is
		// the binding's own and the banner says so rather than letting a reader assume it is the
		// library's.
		Storage.StorageInfo = async function ( Options )
		{
			return jsonstor.BuildStorageInfo( Storage, {
				Product: 'LevelDB',
				Version: DRIVER_PACKAGE.version,
				Banner: `classic-level ${DRIVER_PACKAGE.version}`,
				InProcess: true,
			} );
		};


		//=====================================================================
		// DropStorage
		//=====================================================================


		// ***The collection is dropped and the store is not.***
		//
		// A path holds many collections, so removing the directory the way `jsonstor-folder`
		// removes its folder would take every neighbouring collection with it. Clearing the
		// range removes exactly this storage's documents.
		Storage.DropStorage = async function ( Options )
		{
			let store = await held_store();
			// ***Everything, so the index goes with the documents.*** Clearing only the document
			// range would leave an index describing a collection which is no longer there, and
			// the next insert would be refused as a duplicate of a document nobody can read.
			await store.clear( everything_range() );
			return true;
		};


		//=====================================================================
		// RefreshIndex
		//=====================================================================


		// ***Rebuilds the index from a full scan, and answers how many entries it filed.***
		//
		// This store is this adapter's own, so nothing else writes it and the index cannot drift
		// on its own. It is real work rather than a no-op because the index is jsonstor's rather
		// than the database's - LevelDB has no secondary index to maintain on our behalf - and
		// because a store written by an older version of this adapter has documents and no index
		// at all. Calling it once brings such a store up to date.
		Storage.RefreshIndex = async function ( Options )
		{
			let store = await held_store();
			await store.clear( index_range() );
			let entries = await read_documents();
			let operations = [];
			let filed = 0;
			let seen = {};
			for ( let index = 0; index < entries.length; index++ )
			{
				let value = jsonstor.PrimaryKey.DocumentValue( entries[ index ].Document, Storage.PrimaryKeyInfo.Fields );
				if ( value === null ) { continue; }
				let encoded = jsonstor.PrimaryKey.EncodeValue( value );
				// ***A rebuild reports what it found rather than refusing it.*** A store may
				// already hold a duplicate, and throwing here would leave the storage unusable
				// with no way to look at what is wrong with it.
				if ( seen[ encoded ] ) { continue; }
				seen[ encoded ] = true;
				operations = operations.concat( index_writes( entries[ index ].Document, entries[ index ].Key ) );
				filed++;
			}
			if ( operations.length ) { await store.batch( operations ); }
			return filed;
		};


		//=====================================================================
		// FlushStorage
		//=====================================================================


		// LevelDB writes through its own log as it goes and the binding offers no flush of its
		// own, so there is nothing here to force.
		Storage.FlushStorage = async function ( Options )
		{
			await held_store();
			return true;
		};


		//=====================================================================
		// Count
		//=====================================================================


		Storage.Count = async function ( Criteria, Options )
		{
			if ( jsongin.ShortType( Options ) !== 'o' ) { Options = {}; }
			check_criteria( Criteria );

			// ***An unfiltered count never reads a document.*** Every other adapter's count of
			// everything is a cheap answer from the medium, and a keys-only iterator is this
			// medium's version of one.
			if ( criteria_matches_everything( Criteria ) )
			{
				let counted = await count_documents();
				report_scan( Options, Criteria, counted, counted );
				return counted;
			}

			let looked_up = await find_by_index( Criteria );
			let entries = looked_up ? looked_up.Entries : await read_documents();
			let matched = 0;
			for ( let index = 0; index < entries.length; index++ )
			{
				if ( jsongin.Query( entries[ index ].Document, Criteria ) ) { matched++; }
			}
			if ( looked_up ) { report_lookup( Options, Criteria, entries.length, matched ); }
			else { report_scan( Options, Criteria, entries.length, matched ); }
			return matched;
		};


		//=====================================================================
		// InsertOne
		//=====================================================================


		Storage.InsertOne = async function ( Document, Options )
		{
			if ( jsongin.ShortType( Options ) !== 'o' ) { Options = {}; }
			if ( jsongin.ShortType( Document ) !== 'o' ) { throw new Error( `Document must be an object.` ); }
			let store = await held_store();
			let document = jsongin.Clone( Document );
			apply_new_key( document );
			await require_unique( store, document_key_of( document ), null );
			let document_key = new_document_key();
			let operations = [ { type: 'put', key: document_key, value: JSON.stringify( document ) } ];
			operations = operations.concat( index_writes( document, document_key ) );
			await store.batch( operations );
			if ( Options.ReturnDocuments ) { return document; }
			return 1;
		};


		//=====================================================================
		// InsertMany
		//=====================================================================


		Storage.InsertMany = async function ( Documents, Options )
		{
			if ( jsongin.ShortType( Options ) !== 'o' ) { Options = {}; }
			if ( jsongin.ShortType( Documents ) !== 'a' ) { throw new Error( `Documents must be an array of objects.` ); }
			let store = await held_store();
			let operations = [];
			let inserted = [];
			for ( let index = 0; index < Documents.length; index++ )
			{
				let document = jsongin.Clone( Documents[ index ] );
				apply_new_key( document );
				// ***A duplicate stops the insert where it stands.*** The batch is not yet
				// written, so nothing before it is written either - which is a stronger promise
				// than the other adapters can make and comes free from batching.
				await require_unique( store, document_key_of( document ), null );
				let document_key = new_document_key();
				operations.push( { type: 'put', key: document_key, value: JSON.stringify( document ) } );
				operations = operations.concat( index_writes( document, document_key ) );
				inserted.push( document );
			}
			// ***One batch rather than one write per document.*** The same shape as the round
			// trip per statement which cost this family a measured 34ms against 3.8ms in
			// `jsonstor-mssql` - cheaper here, and no reason to buy the lesson twice.
			if ( operations.length ) { await store.batch( operations ); }
			if ( Options.ReturnDocuments ) { return inserted; }
			return inserted.length;
		};


		//=====================================================================
		// FindOne
		//=====================================================================


		Storage.FindOne = async function ( Criteria, Projection, Options )
		{
			if ( jsongin.ShortType( Options ) !== 'o' ) { Options = {}; }
			check_criteria( Criteria );
			let looked_up = await find_by_index( Criteria );
			if ( looked_up )
			{
				let matched = null;
				for ( let index = 0; index < looked_up.Entries.length; index++ )
				{
					if ( !jsongin.Query( looked_up.Entries[ index ].Document, Criteria ) ) { continue; }
					matched = jsongin.Project( looked_up.Entries[ index ].Document, Projection );
					break;
				}
				report_lookup( Options, Criteria, looked_up.Entries.length, matched ? 1 : 0 );
				return matched;
			}
			let found = await find_first( Criteria );
			let scanned = await count_documents();
			let document = null;
			if ( found ) { document = jsongin.Project( found.Document, Projection ); }
			report_scan( Options, Criteria, scanned, document ? 1 : 0 );
			return document;
		};


		//=====================================================================
		// FindMany
		//=====================================================================


		Storage.FindMany = async function ( Criteria, Projection, Options )
		{
			if ( jsongin.ShortType( Options ) !== 'o' ) { Options = {}; }
			check_criteria( Criteria );
			let looked_up = await find_by_index( Criteria );
			let entries = looked_up ? looked_up.Entries : await read_documents();
			let matches_everything = criteria_matches_everything( Criteria );
			let documents = [];
			for ( let index = 0; index < entries.length; index++ )
			{
				let document = entries[ index ].Document;
				if ( matches_everything || jsongin.Query( document, Criteria ) )
				{
					documents.push( jsongin.Project( document, Projection ) );
				}
			}
			if ( looked_up ) { report_lookup( Options, Criteria, entries.length, documents.length ); }
			else { report_scan( Options, Criteria, entries.length, documents.length ); }
			return documents;
		};


		//=====================================================================
		// FindMany2
		//=====================================================================


		Storage.FindMany2 = async function ( Criteria, Projection, Sort, MaxCount, Options )
		{
			if ( jsongin.ShortType( Options ) !== 'o' ) { Options = {}; }
			check_criteria( Criteria );
			let looked_up = await find_by_index( Criteria );
			let entries = looked_up ? looked_up.Entries : await read_documents();
			let matches_everything = criteria_matches_everything( Criteria );
			let documents = [];
			for ( let index = 0; index < entries.length; index++ )
			{
				let document = entries[ index ].Document;
				if ( matches_everything || jsongin.Query( document, Criteria ) )
				{
					documents.push( jsongin.Project( document, Projection ) );
				}
			}
			if ( Sort ) { documents = jsongin.Sort( documents, Sort ); }
			if ( MaxCount && ( MaxCount > 0 ) && ( documents.length >= MaxCount ) ) { documents = documents.splice( 0, MaxCount ); }
			if ( looked_up ) { report_lookup( Options, Criteria, entries.length, documents.length ); }
			else { report_scan( Options, Criteria, entries.length, documents.length ); }
			return documents;
		};


		//=====================================================================
		// UpdateOne
		//=====================================================================


		Storage.UpdateOne = async function ( Criteria, Updates, Options )
		{
			if ( jsongin.ShortType( Options ) !== 'o' ) { Options = {}; }
			check_criteria( Criteria );
			let store = await held_store();
			let found = await find_first( Criteria );
			let modified = null;
			let modified_count = 0;
			if ( found )
			{
				// ***The key does not move when a document is updated***, so a document keeps
				// the position in the natural order it was inserted at. Rewriting it under a
				// fresh key would send it to the end of the collection, which no other adapter
				// does and no caller asked for.
				modified = jsongin.Update( found.Document, Updates );
				let before = document_key_of( found.Document );
				let after = document_key_of( modified );
				check_key_move( before, after );
				let operations = [ { type: 'put', key: found.Key, value: JSON.stringify( modified ) } ];
				if ( before !== after )
				{
					await require_unique( store, after, found.Key );
					if ( before !== null ) { operations.push( { type: 'del', key: index_key( before ) } ); }
					operations = operations.concat( index_writes( modified, found.Key ) );
				}
				await store.batch( operations );
				modified_count++;
			}
			if ( Options.ReturnDocuments ) { return modified; }
			return modified_count;
		};


		//=====================================================================
		// UpdateMany
		//=====================================================================


		Storage.UpdateMany = async function ( Criteria, Updates, Options )
		{
			if ( jsongin.ShortType( Options ) !== 'o' ) { Options = {}; }
			check_criteria( Criteria );
			let store = await held_store();
			let entries = await read_documents();
			let matches_everything = criteria_matches_everything( Criteria );
			let operations = [];
			let modified = [];
			for ( let index = 0; index < entries.length; index++ )
			{
				let entry = entries[ index ];
				if ( !matches_everything && !jsongin.Query( entry.Document, Criteria ) ) { continue; }
				let document = jsongin.Update( entry.Document, Updates );
				let before = document_key_of( entry.Document );
				let after = document_key_of( document );
				check_key_move( before, after );
				operations.push( { type: 'put', key: entry.Key, value: JSON.stringify( document ) } );
				if ( before !== after )
				{
					await require_unique( store, after, entry.Key );
					if ( before !== null ) { operations.push( { type: 'del', key: index_key( before ) } ); }
					operations = operations.concat( index_writes( document, entry.Key ) );
				}
				modified.push( document );
			}
			if ( operations.length ) { await store.batch( operations ); }
			if ( Options.ReturnDocuments ) { return modified; }
			return modified.length;
		};


		//=====================================================================
		// ReplaceOne
		//=====================================================================


		Storage.ReplaceOne = async function ( Criteria, Document, Options )
		{
			if ( jsongin.ShortType( Options ) !== 'o' ) { Options = {}; }
			if ( jsongin.ShortType( Document ) !== 'o' ) { throw new Error( `Document must be an object.` ); }
			let store = await held_store();
			let found = await find_first( Criteria );
			let modified = null;
			let modified_count = 0;
			if ( found )
			{
				modified = jsongin.Clone( Document );
				// ***A replacement with no primary key carries the matched document's key
				// over.*** This adapter used to throw here, which was one of three behaviors
				// across the family - four adapters threw, three changed the key, six kept it -
				// and the guide's own documented example is the shape which threw.
				let key_field = Storage.PrimaryKeyInfo.Fields[ 0 ];
				if ( typeof jsongin.GetValue( modified, key_field ) === 'undefined' )
				{
					let carried = jsongin.GetValue( found.Document, key_field );
					if ( typeof carried !== 'undefined' ) { jsongin.SetValue( modified, key_field, carried ); }
				}
				let before = document_key_of( found.Document );
				let after = document_key_of( modified );
				check_key_move( before, after );
				let operations = [ { type: 'put', key: found.Key, value: JSON.stringify( modified ) } ];
				if ( before !== after )
				{
					await require_unique( store, after, found.Key );
					if ( before !== null ) { operations.push( { type: 'del', key: index_key( before ) } ); }
					operations = operations.concat( index_writes( modified, found.Key ) );
				}
				await store.batch( operations );
				modified_count++;
			}
			if ( Options.ReturnDocuments ) { return modified; }
			return modified_count;
		};


		//=====================================================================
		// DeleteOne
		//=====================================================================


		Storage.DeleteOne = async function ( Criteria, Options )
		{
			if ( jsongin.ShortType( Options ) !== 'o' ) { Options = {}; }
			check_criteria( Criteria );
			let store = await held_store();
			let found = await find_first( Criteria );
			let deleted = null;
			let deleted_count = 0;
			if ( found )
			{
				deleted = found.Document;
				let operations = [ { type: 'del', key: found.Key } ];
				let encoded = document_key_of( found.Document );
				if ( encoded !== null ) { operations.push( { type: 'del', key: index_key( encoded ) } ); }
				await store.batch( operations );
				deleted_count++;
			}
			if ( Options.ReturnDocuments ) { return deleted; }
			return deleted_count;
		};


		//=====================================================================
		// DeleteMany
		//=====================================================================


		Storage.DeleteMany = async function ( Criteria, Options )
		{
			if ( jsongin.ShortType( Options ) !== 'o' ) { Options = {}; }
			check_criteria( Criteria );
			let store = await held_store();
			let entries = await read_documents();
			let matches_everything = criteria_matches_everything( Criteria );
			let operations = [];
			let deleted = [];
			for ( let index = 0; index < entries.length; index++ )
			{
				let entry = entries[ index ];
				if ( !matches_everything && !jsongin.Query( entry.Document, Criteria ) ) { continue; }
				operations.push( { type: 'del', key: entry.Key } );
				let encoded = document_key_of( entry.Document );
				if ( encoded !== null ) { operations.push( { type: 'del', key: index_key( encoded ) } ); }
				deleted.push( entry.Document );
			}
			if ( operations.length ) { await store.batch( operations ); }
			if ( Options.ReturnDocuments ) { return deleted; }
			return deleted.length;
		};


		//=====================================================================
		return Storage;
	},

};
