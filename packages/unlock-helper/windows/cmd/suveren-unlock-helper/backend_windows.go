//go:build windows

package main

import "github.com/suverenai/suveren-gateway/packages/unlock-helper/windows/internal/helper"

func defaultBackend() helper.Backend { return helper.TPMBackend{} }
