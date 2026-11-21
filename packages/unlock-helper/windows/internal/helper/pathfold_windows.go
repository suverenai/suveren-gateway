//go:build windows

package helper

import "strings"

// Windows paths compare without case (NTFS default).
func pathEqual(a, b string) bool     { return strings.EqualFold(a, b) }
func pathHasPrefix(s, p string) bool { return hasPrefixFold(s, p) }
