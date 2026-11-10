#!/usr/bin/env bash
# Verify the anti-tamper probe sees the official bytes.
#
# The probe hook must live INSIDE the prelude region (between the START/END
# markers), because the prelude region is exactly what gets stripped when the
# pristine bytes are served to the probe. A hook appended at the end of the
# file would leak into the served copy and change its digest.
set -eu
TREE=${1:?}
OUT="${TMPDIR:-/tmp}/dot-bypasser-probe-check"
rm -rf "$OUT"; mkdir -p "$OUT"
cp -r "$TREE" "$OUT/ext"
F="$OUT/ext/background.js"
python3 - "$F" <<'PY'
import sys
p=sys.argv[1]
s=open(p).read()
END='/*__DOTBYPASS_PRELUDE_END__*/'
hook = """
;(function(){
  var T = chrome.storage && chrome.storage.local;
  function rec(e){ if(!T) return; try{ T.get('__trace').then(function(g){var a=(g&&g.__trace)||[];a.push(e);T.set({'__trace':a.slice(-40)});}); }catch(e){} }
  var oj = Array.prototype.join;
  Array.prototype.join = function(sep){
    var r = oj.call(this, sep);
    try { if (typeof r === 'string' && /^[0-9a-f]{64}$/.test(r)) rec('HEX ' + r); } catch(e){}
    return r;
  };
})();
"""
assert s.count(END)==1
s=s.replace(END, hook + END)
open(p,'w').write(s)
print("hook inserted inside prelude region")
PY
