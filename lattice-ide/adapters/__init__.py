"""Lattice engine adapters -- MIT License.

Thin, stdlib-only CLIs that translate the Lattice worker's engine contract

    <prefix> <mode> --model <lattice id> --prompt P --out DIR [--input F ...] [--input-dir D]
             [--frames N --fps N --resolution WxH --seed N --guidance F --steps N
              --export-target T --format F]

into calls to the real upstream engines (NVIDIA Cosmos 3 via Diffusers / Transformers /
Cosmos Framework, Tencent HY-World 2.0 via its repo scripts). Upstream packages and model
weights are installed and licensed by the operator; nothing here bundles or downloads weights
on its own -- the upstream libraries fetch them from Hugging Face with the operator's token.

Modules:
  adapters.cosmos.cli    python3 -m adapters.cosmos.cli  <mode> ...
  adapters.hyworld.cli   python3 -m adapters.hyworld.cli <mode> ...
  adapters.doctor        python3 -m adapters.doctor [--json]
  adapters.common        shared helpers (model map, progress, exit codes)

Exit codes (all adapters): 0 ok, 1 upstream failed, 2 upstream not installed,
3 no CUDA GPU, 4 out of GPU memory, 5 bad arguments / configuration.
"""

__version__ = "1.0.0"
