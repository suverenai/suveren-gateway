/**
 * The browser-safe part of hap-core (`@humanagencyp/hap-core/browser`, from 0.17.0): mandate verification, the owner-signature
 * projection, profile hashing, the execution-context filter, did:key and `deviceKeys`, with no Node built-in. The phone app
 * imports this; the Node apps keep the main entry.
 */
export * from '@humanagencyp/hap-core/browser';
