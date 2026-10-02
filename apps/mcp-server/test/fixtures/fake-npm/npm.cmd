@echo off
rem Windows trampoline — mirrors ./npm, see fake-npm.mjs for behaviour.
node "%~dp0fake-npm.mjs" %*
