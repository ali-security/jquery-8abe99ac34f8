/*
 * Headless Chrome runner for the jQuery QUnit browser suite (test/index.html).
 *
 * Runs on a modern Node (>= 18) with puppeteer-core resolvable via require()
 * (e.g. NODE_PATH=/some/dir/node_modules). It is CI tooling only: it lives in
 * test/ (excluded from the npm package by .npmignore) and is listed in
 * .jshintignore so the Gruntfile jshint task does not lint it.
 *
 * Usage:
 *   CHROME_BIN=/usr/bin/google-chrome node test/run-qunit-headless.js [url]
 *
 * Env:
 *   CHROME_BIN        Chrome/Chromium binary (default: google-chrome)
 *   QUNIT_TIMEOUT_MS  overall timeout waiting for QUnit.done (default: 15 min)
 *
 * Exit code: 0 when every test passed, 1 on any failed assertion/test, when no
 * test ran, or when QUnit.done did not fire before the timeout.
 */
"use strict";

var puppeteer = require( "puppeteer-core" );

var url = process.argv[ 2 ] || "http://127.0.0.1:8000/test/index.html?dev";
var chromeBin = process.env.CHROME_BIN || "google-chrome";
var timeoutMs = parseInt( process.env.QUNIT_TIMEOUT_MS || "", 10 ) || 15 * 60 * 1000;

// Grace period after QUnit.done before trusting it (QUnit 1.x may report
// "done" early if the queue drains while tests are still being loaded).
var DONE_GRACE_MS = 3000;

// Watchdog: fail with a diagnosis if QUnit makes no progress (no testDone /
// failed-assertion log callback) for this long, well before Travis' 10-minute
// no-output kill.
var STALL_MS = 3 * 60 * 1000;

// Injected into every frame before any page script runs. Only the top-level
// window reports; fixture iframes reuse parent.QUnit and are ignored.
function installHooks() {
	if ( window.top !== window ) {
		return;
	}

	var qunitRef;
	var hooked = false;

	function send( type, data ) {
		try {
			window.__qunitReport( JSON.stringify( { type: type, data: data } ) );
		} catch ( e ) {}
	}

	function dump( value ) {
		try {
			if ( qunitRef && qunitRef.jsDump ) {
				return qunitRef.jsDump.parse( value );
			}
		} catch ( e ) {}
		try {
			return String( value );
		} catch ( e2 ) {
			return "[unprintable]";
		}
	}

	function hook( Q ) {
		if ( hooked || !Q || typeof Q.log !== "function" ) {
			return;
		}
		hooked = true;

		// Guard against a late second QUnit.load(). testinit.js calls
		// QUnit.load() + QUnit.start() itself once require has loaded every
		// unit file, but qunit.js also registered QUnit.load as a window
		// "load" listener. If window load fires after tests have started,
		// QUnit.init() rebuilds #qunit-tests and the running test's <li>
		// vanishes (TypeError in finish(), suite stalls). Ignore any
		// QUnit.load() once a test has started; earlier calls pass through.
		var testsStarted = false;
		var origLoad = Q.load;
		Q.testStart( function() {
			testsStarted = true;
		} );
		if ( typeof origLoad === "function" ) {
			var guardedLoad = function() {
				if ( testsStarted ) {
					send( "runnerNote", {
						message: "ignored late QUnit.load() (window load after tests started)"
					} );
					return;
				}
				return origLoad.apply( this, arguments );
			};
			Q.load = guardedLoad;
			window.removeEventListener( "load", origLoad, false );
			window.addEventListener( "load", guardedLoad, false );
		}

		Q.begin( function() {
			send( "begin", {} );
		} );
		Q.moduleStart( function( d ) {
			send( "moduleStart", { name: d.name } );
		} );
		Q.testStart( function( d ) {
			send( "testStart", { module: d.module, name: d.name } );
		} );
		Q.log( function( d ) {
			if ( d.result ) {
				return;
			}
			send( "log", {
				module: d.module,
				name: d.name,
				message: d.message === undefined ? "" : String( d.message ),
				hasExpected: Object.prototype.hasOwnProperty.call( d, "expected" ),
				expected: dump( d.expected ),
				actual: dump( d.actual ),
				source: d.source || ""
			} );
		} );
		Q.testDone( function( d ) {
			send( "testDone", {
				module: d.module,
				name: d.name,
				failed: d.failed,
				passed: d.passed,
				total: d.total,
				runtime: d.runtime
			} );
		} );
		Q.moduleDone( function( d ) {
			send( "moduleDone", {
				name: d.name,
				failed: d.failed,
				passed: d.passed,
				total: d.total
			} );
		} );
		Q.done( function( d ) {
			send( "done", {
				failed: d.failed,
				passed: d.passed,
				total: d.total,
				runtime: d.runtime
			} );
		} );
	}

	// Intercept the moment qunit.js assigns window.QUnit, so the hooks are
	// registered before testinit.js/testrunner.js and any test is queued.
	Object.defineProperty( window, "QUnit", {
		configurable: true,
		enumerable: true,
		get: function() {
			return qunitRef;
		},
		set: function( value ) {
			qunitRef = value;
			hook( value );
		}
	} );
}

function pad( n ) {
	return n < 10 ? "0" + n : String( n );
}

function fmtDuration( ms ) {
	var s = Math.round( ms / 1000 );
	return Math.floor( s / 60 ) + "m" + pad( s % 60 ) + "s";
}

function indent( text, prefix ) {
	return String( text ).split( "\n" ).map( function( l ) {
		return prefix + l;
	} ).join( "\n" );
}

async function main() {
	var started = Date.now();
	var tests = { passed: 0, failed: 0 };
	var failedTests = [];
	var pendingFailures = [];
	var doneData = null;
	var doneTimer = null;
	var lastProgress = Date.now();
	var lastTestStarted = "(none)";
	var finish;
	var finished = new Promise( function( resolve ) {
		finish = resolve;
	} );

	console.log( "QUnit headless runner" );
	console.log( "  url:    " + url );
	console.log( "  chrome: " + chromeBin );
	console.log( "  timeout: " + fmtDuration( timeoutMs ) );
	console.log( "  node:   " + process.version );

	var browser = await puppeteer.launch( {
		executablePath: chromeBin,
		headless: false, // headless mode is selected explicitly via --headless=new below
		args: [
			"--headless=new",
			"--no-sandbox",
			"--disable-gpu",
			"--hide-scrollbars",
			"--mute-audio",
			"--disable-dev-shm-usage",
			"--disable-background-timer-throttling",
			"--disable-renderer-backgrounding",
			"--disable-backgrounding-occluded-windows",
			"--window-size=1280,1024"
		],
		defaultViewport: { width: 1280, height: 1024 },
		protocolTimeout: timeoutMs + 60 * 1000
	} );

	var exitCode = 1;
	try {
		var page = await browser.newPage();
		page.setDefaultNavigationTimeout( 120 * 1000 );

		page.on( "console", function( msg ) {
			var type = msg.type();
			if ( type === "error" || type === "assert" ) {
				console.log( "[console." + type + "] " + msg.text() );
			}
		} );
		page.on( "pageerror", function( err ) {
			console.log( "[pageerror] " + ( err && err.stack || err ) );
		} );

		await page.exposeFunction( "__qunitReport", function( raw ) {
			var msg = JSON.parse( raw );
			var d = msg.data;
			switch ( msg.type ) {
			case "moduleStart":
				console.log( "\nModule: " + d.name );
				break;
			case "runnerNote":
				console.log( "[runner] " + d.message );
				break;
			case "testStart":
				lastTestStarted = d.module + " :: " + d.name;
				pendingFailures = [];
				if ( doneTimer ) {
					// More tests started after an early "done"; keep waiting.
					clearTimeout( doneTimer );
					doneTimer = null;
					doneData = null;
				}
				break;
			case "log":
				lastProgress = Date.now();
				pendingFailures.push( d );
				break;
			case "testDone":
				lastProgress = Date.now();
				var ok = d.failed === 0;
				if ( ok ) {
					tests.passed++;
				} else {
					tests.failed++;
					failedTests.push( d.module + " :: " + d.name );
				}
				console.log( ( ok ? "PASS" : "FAIL" ) + " " + d.module + " :: " + d.name +
					" (" + d.passed + "/" + d.total + " assertions, " + d.runtime + "ms)" );
				pendingFailures.forEach( function( f ) {
					console.log( "    - " + ( f.message || "(no message)" ) );
					if ( f.hasExpected ) {
						console.log( "      expected: " + indent( f.expected, "                " ).trim() );
						console.log( "      actual:   " + indent( f.actual, "                " ).trim() );
					}
					if ( f.source ) {
						console.log( f.source.split( "\n" ).map( function( l ) {
							return "      " + l.trim();
						} ).join( "\n" ) );
					}
				} );
				pendingFailures = [];
				break;
			case "moduleDone":
				console.log( "Module " + d.name + ": " + d.passed + "/" + d.total +
					" assertions passed, " + d.failed + " failed" );
				break;
			case "done":
				doneData = d;
				if ( doneTimer ) {
					clearTimeout( doneTimer );
				}
				doneTimer = setTimeout( function() {
					finish( "done" );
				}, DONE_GRACE_MS );
				break;
			}
		} );

		await page.evaluateOnNewDocument( installHooks );

		var timer = setTimeout( function() {
			finish( "timeout" );
		}, timeoutMs );

		var watchdog = setInterval( function() {
			if ( !doneTimer && Date.now() - lastProgress >= STALL_MS ) {
				console.log( "STALLED: no QUnit progress for " + fmtDuration( STALL_MS ) +
					"; last test started: " + lastTestStarted );
				finish( "stalled" );
			}
		}, 5000 );

		var resp = await page.goto( url, { waitUntil: "load" } );
		if ( !resp || !resp.ok() ) {
			console.log( "ERROR: failed to load " + url + " (HTTP " +
				( resp ? resp.status() : "no response" ) + ")" );
			clearTimeout( timer );
			finish( "loadError" );
		}

		var reason = await finished;
		clearTimeout( timer );
		clearInterval( watchdog );

		console.log( "\n==================================================" );
		if ( reason === "done" && doneData ) {
			var totalTests = tests.passed + tests.failed;
			if ( failedTests.length ) {
				console.log( "Failed tests:" );
				failedTests.forEach( function( t ) {
					console.log( "  - " + t );
				} );
			}
			console.log( "Tests completed in " + fmtDuration( doneData.runtime ) + ": " +
				totalTests + " tests (" + tests.passed + " passed, " + tests.failed + " failed), " +
				doneData.total + " assertions (" + doneData.passed + " passed, " +
				doneData.failed + " failed)" );
			if ( totalTests === 0 ) {
				console.log( "RESULT: FAILURE (no tests ran)" );
			} else if ( doneData.failed > 0 || tests.failed > 0 ) {
				console.log( "RESULT: FAILURE" );
			} else {
				console.log( "RESULT: SUCCESS" );
				exitCode = 0;
			}
		} else if ( reason === "timeout" ) {
			console.log( "RESULT: FAILURE (QUnit.done did not fire within " +
				fmtDuration( timeoutMs ) + "; " + ( tests.passed + tests.failed ) +
				" tests finished: " + tests.passed + " passed, " + tests.failed + " failed)" );
		} else if ( reason === "stalled" ) {
			console.log( "RESULT: FAILURE (stalled: no QUnit progress for " +
				fmtDuration( STALL_MS ) + "; last test started: " + lastTestStarted + "; " +
				( tests.passed + tests.failed ) + " tests finished: " + tests.passed +
				" passed, " + tests.failed + " failed)" );
		} else {
			console.log( "RESULT: FAILURE (" + reason + ")" );
		}
		console.log( "Wall time: " + fmtDuration( Date.now() - started ) );
	} finally {
		await browser.close().catch( function() {} );
	}
	return exitCode;
}

main().then( function( code ) {
	process.exit( code );
}, function( err ) {
	console.error( "Runner error: " + ( err && err.stack || err ) );
	process.exit( 1 );
} );
