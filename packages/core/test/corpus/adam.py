import math
import torch


def adam_step(theta, g, m, v, lr, beta1, beta2, eps, t):
    """One Adam optimizer step."""
    m = beta1 * m + (1 - beta1) * g
    v = beta2 * v + (1 - beta2) * (g * g)
    m_hat = m / (1 - beta1 ** t)
    v_hat = v / (1 - beta2 ** t)
    theta = theta - lr * m_hat / (torch.sqrt(v_hat) + eps)
    return theta


def sgd_momentum(theta, g, v, lr, mu):
    v = mu * v + g
    theta = theta - lr * v
    return theta
