//go:build !windows

package main

import "github.com/suverenai/suveren-gateway/packages/unlock-helper/windows/internal/helper"

// Built on a Mac or Linux only to run the protocol tests: no key storage.
type noBackend struct{}

func (noBackend) Capabilities() helper.Capabilities {
	return helper.Capabilities{Backend: "none", SecureHardware: false}
}
func (noBackend) CreateAgreementKey(helper.Policy) ([]byte, helper.AgreementKey, error) {
	return nil, nil, helper.Err("no_secure_hardware", "No key storage on this system.")
}
func (noBackend) OpenAgreementKey([]byte, helper.Prompt) (helper.AgreementKey, error) {
	return nil, helper.Err("no_secure_hardware", "No key storage on this system.")
}
func (noBackend) CreateSigningKey(helper.Policy) ([]byte, helper.SigningKey, error) {
	return nil, nil, helper.Err("no_secure_hardware", "No key storage on this system.")
}
func (noBackend) OpenSigningKey([]byte, helper.Prompt) (helper.SigningKey, error) {
	return nil, helper.Err("no_secure_hardware", "No key storage on this system.")
}

func defaultBackend() helper.Backend { return noBackend{} }
