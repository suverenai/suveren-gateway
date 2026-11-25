//go:build !hellomeasured

package helper

// measured is false until a person has checked on a real Windows 11 machine with Windows Hello and a TPM 2.0 that the
// Platform Crypto Provider asks at every use (DESIGN.md section 8 and its manual check). Then build with
// -tags hellomeasured. Until then the helper reports no secure hardware and the gateway keeps the password.
const measured = false
