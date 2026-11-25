//go:build windows

package helper

// Windows paths compare without case for ASCII letters only (NTFS default for them); every other character must
// match exactly (no Unicode case folding — M1b).
func pathEqual(a, b string) bool     { return equalFoldASCII(a, b) }
func pathHasPrefix(s, p string) bool { return hasPrefixFold(s, p) }
