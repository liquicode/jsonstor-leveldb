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
		// The half-open key range holding exactly this collection.
		function collection_range()
		{
			return {
				gte: Storage.Settings.CollectionName + SEPARATOR,
				lt: Storage.Settings.CollectionName + TERMINATOR,
			};
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
			await store.clear( collection_range() );
			return true;
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

			let entries = await read_documents();
			let matched = 0;
			for ( let index = 0; index < entries.length; index++ )
			{
				if ( jsongin.Query( entries[ index ].Document, Criteria ) ) { matched++; }
			}
			report_scan( Options, Criteria, entries.length, matched );
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
			if ( typeof document._id === 'undefined' ) { document._id = jsonstor.NewUniqueID(); }
			await store.put( new_document_key(), JSON.stringify( document ) );
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
				if ( typeof document._id === 'undefined' ) { document._id = jsonstor.NewUniqueID(); }
				operations.push( { type: 'put', key: new_document_key(), value: JSON.stringify( document ) } );
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
			let entries = await read_documents();
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
			report_scan( Options, Criteria, entries.length, documents.length );
			return documents;
		};


		//=====================================================================
		// FindMany2
		//=====================================================================


		Storage.FindMany2 = async function ( Criteria, Projection, Sort, MaxCount, Options )
		{
			if ( jsongin.ShortType( Options ) !== 'o' ) { Options = {}; }
			check_criteria( Criteria );
			let entries = await read_documents();
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
			report_scan( Options, Criteria, entries.length, documents.length );
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
				await store.put( found.Key, JSON.stringify( modified ) );
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
				operations.push( { type: 'put', key: entry.Key, value: JSON.stringify( document ) } );
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
			if ( jsongin.ShortType( Document._id ) === 'u' ) { throw new Error( `Document must contain an _id field.` ); }
			let store = await held_store();
			let found = await find_first( Criteria );
			let modified = null;
			let modified_count = 0;
			if ( found )
			{
				modified = jsongin.Clone( Document );
				await store.put( found.Key, JSON.stringify( modified ) );
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
				await store.del( found.Key );
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
