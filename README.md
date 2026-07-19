# mltex

mltex is a VS Code extension and language server that translates
Python and PyTorch code into linked mathematical notation. 

## Testing

[`testing/fixtures`](testing/fixtures) contains seven attributed Python
excerpts covering Kalman filtering, ResNet, Transformer attention, I-JEPA,
V-JEPA 2, and CLIP. The papers define the equations; executable excerpts come
from pinned public implementations.

These files are future translator inputs, not an automated test suite. Add a
runner and expected outputs only when mltex can translate the first example.
Add another fixture only when a translator capability or regression needs it.

### Fixture Reference

Use these equations for human review. They are not expected-output snapshots.

#### Kalman Filter

- Fixture: [`01_kalman_filter.py`](testing/fixtures/01_kalman_filter.py)
- Paper: [Kalman, 1960](https://doi.org/10.1115/1.3662552)
- Source: [FilterPy `kalman_filter.py`](https://github.com/rlabbe/filterpy/blob/3b51149ebcff0401ff1e10bf08ffca7b6bbc4a33/filterpy/kalman/kalman_filter.py)
- License: MIT

The fixture extracts equation-bearing statements from `predict` and `update`
and replaces object state with function parameters.

```latex
\hat{x}_{k|k-1} = F_k x_{k-1}
```

```latex
P_{k|k-1} = F_k P_{k-1} F_k^\top + Q_k
```

```latex
y_k = z_k - H_k\hat{x}_{k|k-1}
```

```latex
S_k = H_kP_{k|k-1}H_k^\top + R_k
```

```latex
K_k = P_{k|k-1}H_k^\top S_k^{-1}
```

```latex
x_k = \hat{x}_{k|k-1} + K_ky_k
```

The fixture uses the Joseph covariance update:

```latex
P_k = (I-K_kH_k)P_{k|k-1}(I-K_kH_k)^\top + K_kR_kK_k^\top
```

#### ResNet Basic Block

- Fixture: [`02_resnet_basic_block.py`](testing/fixtures/02_resnet_basic_block.py)
- Paper: [He et al., 2015](https://arxiv.org/abs/1512.03385)
- Source: [torchvision `resnet.py`](https://github.com/pytorch/vision/blob/f23f832d090c868691855cc1261ed907e400c2a2/torchvision/models/resnet.py)
- License: BSD-3-Clause

The fixture copies `BasicBlock.forward` and removes type annotations.

```latex
\mathcal{F}(x) = W_2\,\sigma(W_1x)
```

```latex
y = \sigma(\mathcal{F}(x) + P(x))
```

`P(x)` is either the identity or the downsampling projection.

#### Scaled Dot-Product Attention

- Fixture: [`03_scaled_dot_product_attention.py`](testing/fixtures/03_scaled_dot_product_attention.py)
- Paper: [Vaswani et al., 2017](https://arxiv.org/abs/1706.03762)
- Source: [The Annotated Transformer](https://github.com/harvardnlp/annotated-transformer/blob/debc9fd747bb2123160a98046ad1c2d4da44a567/the_annotated_transformer.py)
- License: MIT

The fixture copies `attention`, renames `p_attn` to `probabilities`, and
shortens the docstring.

```latex
\operatorname{Attention}(Q,K,V) =
\operatorname{softmax}\left(\frac{QK^\top}{\sqrt{d_k}}\right)V
```

Masked scores are set to a large negative value before softmax.

#### I-JEPA Transformer Block

- Fixture: [`04_ijepa_transformer_block.py`](testing/fixtures/04_ijepa_transformer_block.py)
- Paper: [Assran et al., 2023](https://arxiv.org/abs/2301.08243)
- Source: [Hugging Face Transformers `modeling_ijepa.py`](https://github.com/huggingface/transformers/blob/7ea2320c76117e6742364808a666ef6f2fb40a67/src/transformers/models/ijepa/modeling_ijepa.py)
- License: Apache-2.0

The fixture extracts `IJepaLayer.forward`, removes type annotations and keyword
forwarding, and retains both pre-norm residual updates.

```latex
u = x + \operatorname{Dropout}
  \left(\operatorname{Attention}(\operatorname{LN}_1(x), M)\right)
```

```latex
y = u + \operatorname{Dropout}
  \left(\operatorname{MLP}(\operatorname{LN}_2(u))\right)
```

`M` is the optional attention mask.

#### V-JEPA 2 Rotary Embedding

- Fixture: [`05_vjepa2_rotary_embedding.py`](testing/fixtures/05_vjepa2_rotary_embedding.py)
- Paper: [Assran et al., 2025](https://arxiv.org/abs/2506.09985)
- Source: [Hugging Face Transformers `modeling_vjepa2.py`](https://github.com/huggingface/transformers/blob/7ea2320c76117e6742364808a666ef6f2fb40a67/src/transformers/models/vjepa2/modeling_vjepa2.py)
- License: Apache-2.0

The fixture extracts `rotate_queries_or_keys`, renames intermediate variables,
and removes explanatory comments.

For pair index `j`, feature width `D`, and position `p`:

```latex
\omega_j = 10000^{-j/(D/2)}
```

```latex
\theta_{p,j} = p\,\omega_j
```

```latex
\operatorname{RoPE}(x,p) =
x \odot \cos(\theta_p)
+ \operatorname{rotatePairs}(x) \odot \sin(\theta_p)
```

The pair rotation maps `(x_0, x_1)` to `(-x_1, x_0)`.

#### CLIP Similarity

- Fixture: [`06_clip_similarity.py`](testing/fixtures/06_clip_similarity.py)
- Paper: [Radford et al., 2021](https://arxiv.org/abs/2103.00020)
- Source: [OpenAI CLIP `model.py`](https://github.com/openai/CLIP/blob/d05afc436d78f1c48dc0dbf8e5980a9d471f35f6/clip/model.py)
- License: MIT

The fixture extracts normalization and similarity from `CLIP.forward` and
makes the encoded features function parameters.

```latex
\bar{I}_i = \frac{I_i}{\lVert I_i \rVert_2},
\qquad
\bar{T}_j = \frac{T_j}{\lVert T_j \rVert_2}
```

```latex
L_{ij} = \exp(t)\,\bar{I}_i^\top \bar{T}_j
```

```latex
L_{\mathrm{text}} = L_{\mathrm{image}}^\top
```

#### I-JEPA Masked Prediction

- Fixture: [`07_ijepa_masked_prediction.py`](testing/fixtures/07_ijepa_masked_prediction.py)
- Paper: [Assran et al., 2023](https://arxiv.org/abs/2301.08243)
- Source: [gaasher/I-JEPA `model.py`](https://github.com/gaasher/I-JEPA/blob/98b4ed2c0232a210ed149821e1d8897678d61eb6/model.py)
- Loss: [gaasher/I-JEPA `pretrain_IJEPA.py`](https://github.com/gaasher/I-JEPA/blob/98b4ed2c0232a210ed149821e1d8897678d61eb6/pretrain_IJEPA.py)
- License: MIT

The fixture retains patch embedding, target/context block sampling, teacher and
student encoding, predictor masks, and MSE loss. It renames variables, removes
the inference branch, and replaces hardcoded CUDA allocations with input-device
allocations.

```latex
X = E_{\mathrm{patch}}(I) + P
```

For target patch sets `T_m` and a context set `C` that excludes their union:

```latex
H_m = \left[\bar{f}_{\xi}(X)\right]_{\mathcal{T}_m}
```

```latex
Z = f_{\theta}\left(X_{\mathcal{C}}\right)
```

```latex
\widehat{H}_m =
g_{\phi}\left(
  \left[Z;\,M + P_{\mathcal{T}_m}\right]
\right)
```

```latex
\mathcal{L} =
\operatorname{mean}_{m,b,n,d}
\left(\widehat{H}_{m,b,n,d} - H_{m,b,n,d}\right)^2
```
