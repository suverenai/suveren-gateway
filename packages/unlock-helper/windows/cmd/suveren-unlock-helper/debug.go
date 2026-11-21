//go:build debug

package main

import "github.com/suverenai/suveren-gateway/packages/unlock-helper/windows/internal/helper"

// Debug builds only: the switches the tests need. A release build (release.go) has none of them, so no caller can
// make the shipped helper use software keys or skip the caller check.
type options struct {
	softwareBackend bool
	allowAnyCaller  bool
	allowedCallers  string
}

func parseOptions(args []string) options {
	var o options
	for i := 0; i < len(args); i++ {
		switch args[i] {
		case "--backend":
			if i+1 < len(args) && args[i+1] == "software" {
				o.softwareBackend = true
				i++
			}
		case "--allow-any-caller":
			o.allowAnyCaller = true
		case "--allowed-callers":
			if i+1 < len(args) {
				o.allowedCallers = args[i+1]
				i++
			}
		}
	}
	return o
}

func softwareBackend() helper.Backend { return helper.SoftwareBackend{} }
