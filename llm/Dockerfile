FROM vllm/vllm-openai:latest

ARG LLM_MODEL=bg-digitalservices/Gemma-4-E2B-NVFP4
ARG HF_TOKEN
ARG MODEL_DIR=/models/gemma-4-e2b-nvfp4

ENV LLM_MODEL=${LLM_MODEL}
ENV HF_TOKEN=${HF_TOKEN}
ENV MODEL_DIR=${MODEL_DIR}

# Build 時預載模型，部署不需要網路
#RUN python3 -c "from huggingface_hub import snapshot_download; \
#snapshot_download('${LLM_MODEL}', token='${HF_TOKEN}')"
RUN python3 << 'EOF'
from huggingface_hub import snapshot_download
from safetensors import safe_open
import os
import json

model_id = os.environ.get('LLM_MODEL')
token = os.environ.get('HF_TOKEN')
model_dir = os.environ.get('MODEL_DIR')

print(f"Downloading model: {model_id}")
print(f"Using token: {'***' if token else 'None'}")
print(f"Target directory: {model_dir}")

try:
    path = snapshot_download(
        model_id,
        token=token,
        local_dir=model_dir,
        local_dir_use_symlinks=False,
    )
    print(f"✓ Model downloaded successfully to: {path}")

    weight_file = os.path.join(path, "model.safetensors")
    index_file = os.path.join(path, "model.safetensors.index.json")

    # 這個模型目前會發布單一 safetensors 檔案與空的 index。
    # vLLM 會依照 index 篩選 safetensors，空 index 會讓它看不到任何權重，
    # 所以只移除這個已知為空的 placeholder。
    if os.path.exists(index_file):
        with open(index_file, "r", encoding="utf-8") as f:
            index = json.load(f)
        if index.get("weight_map") == {}:
            os.remove(index_file)
            print("✓ Removed empty model.safetensors.index.json placeholder")

    with safe_open(weight_file, framework="pt", device="cpu") as f:
        keys = list(f.keys())
    print(f"✓ Validated safetensors file with {len(keys)} tensors")

except Exception as e:
    print(f"✗ Failed to download model: {e}")
    raise
EOF

ENV HF_TOKEN=""

# 驗證模型檔案確實存在
RUN ls -lah ${MODEL_DIR}

EXPOSE 8001

ENTRYPOINT ["python3", "-m", "vllm.entrypoints.openai.api_server"]
CMD ["--model", "/models/gemma-4-e2b-nvfp4", "--served-model-name", "bg-digitalservices/Gemma-4-E2B-NVFP4", "--quantization", "modelopt", "--trust-remote-code", "--port", "8001", "--max-model-len", "131072", "--dtype", "auto", "--gpu-memory-utilization", "0.4", "--kv-cache-dtype", "fp8", "--load-format", "safetensors"]
