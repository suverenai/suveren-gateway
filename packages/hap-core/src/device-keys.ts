/**
 * Device keys (recovery code, root key, chain entries, sign-in). Re-exported
 * from the published package so `@hap/core/device-keys` works in the workspace;
 * in the shipped bundle `@hap/core` is an npm alias of `@humanagencyp/hap-core`
 * (bundle/build.mjs), whose `./device-keys` export exists from 0.14.0 on.
 *
 * @experimental The protocol does not define device enrolment yet.
 */
export * from '@humanagencyp/hap-core/device-keys';
