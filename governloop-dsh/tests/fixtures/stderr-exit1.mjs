// Test fixture: writes to stderr and exits 1.
// Used by unit-relay.test.mjs to pin runSessionManager stderr capture
// (AGE-65 Product Closure P1c — failure propagation).
console.error('stub failure on stderr')
process.exit(1)
