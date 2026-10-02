/**
 * Re-export the decoder so the e2e script exercises the UI's own code path.
 *
 * `PROTOCOL_VERSION` travels with it for the same reason and it is not a
 * convenience: this script used to assert `init.protocol === 3` as a **literal**
 * while `src/protocol/types.ts` said 4, so two declarations of one fact
 * disagreed and each had a test backing it. A second literal is how that
 * happens, so the assertion below compares the runtime's answer against this
 * constant rather than against a number written here.
 */
export { decodeLine, PROTOCOL_VERSION } from '@/protocol/types';
