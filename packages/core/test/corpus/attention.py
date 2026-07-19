import math
import torch


def scaled_dot_product_attention(Q, K, V, d):
    """Scaled dot-product attention."""
    scores = Q @ K.T / math.sqrt(d)
    A = torch.softmax(scores, -1)
    out = A @ V
    return out


def attention_jaxtyped(
    Q: Float[Tensor, "b s d"],
    K: Float[Tensor, "b s d"],
    V: Float[Tensor, "b s d"],
) -> Float[Tensor, "b s d"]:
    """Attention with jaxtyping-declared shapes."""
    scores = Q @ K.mT / math.sqrt(64)  # (b, s, s)
    A = scores.softmax(-1)
    out = A @ V
    return out


def masked_attention(Q, K, V, mask, d):
    scores = Q @ K.T / math.sqrt(d)
    scores = scores + mask
    attn = torch.softmax(scores, -1)  # tex: \tilde{A}
    return attn @ V
