//go:build !windows

package helper

import "strings"

func pathEqual(a, b string) bool     { return a == b }
func pathHasPrefix(s, p string) bool { return strings.HasPrefix(s, p) }
