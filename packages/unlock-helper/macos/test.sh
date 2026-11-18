#!/bin/sh
# Runs the Swift tests. With full Xcode, plain `swift test` works. With the command-line tools only,
# Swift Testing lives outside the default search path, so the paths are added here.
set -e
cd "$(dirname "$0")"
D=/Library/Developer/CommandLineTools/Library/Developer
if [ -d "$D/Frameworks/Testing.framework" ] && ! xcode-select -p | grep -q Xcode; then
  exec swift test -Xswiftc -F -Xswiftc "$D/Frameworks" -Xlinker -F -Xlinker "$D/Frameworks" \
    -Xlinker -rpath -Xlinker "$D/Frameworks" -Xlinker -rpath -Xlinker "$D/usr/lib" "$@"
fi
exec swift test "$@"
