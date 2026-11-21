//go:build !windows

package helper

// This helper is for Windows. Built elsewhere (to run the protocol tests on a Mac or Linux), there is no parent
// check: a release build refuses every caller, a debug build must be told --allow-any-caller.

type ParentHandle struct{}

func ParentPID() (uint32, error) { return 0, Err("caller_refused", "No parent check on this system.") }
func OpenParent(uint32) (*ParentHandle, error) {
	return nil, Err("caller_refused", "No parent check on this system.")
}
func CheckParent(*ParentHandle, []AllowedCaller) string { return "no parent check on this system" }
