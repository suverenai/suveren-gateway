//go:build !debug

package main

import "github.com/suverenai/suveren-gateway/packages/unlock-helper/windows/internal/helper"

// Release: no switches. Every argument after `serve` is ignored.
type options struct {
	softwareBackend bool
	allowAnyCaller  bool
	allowedCallers  string
}

func parseOptions([]string) options { return options{} }

func softwareBackend() helper.Backend { return nil }
