import torch


def gru_cell(x, h, W_z, U_z, W_r, U_r, W_h, U_h):
    """One GRU cell step."""
    z = torch.sigmoid(W_z @ x + U_z @ h)
    r = torch.sigmoid(W_r @ x + U_r @ h)
    h_tilde = torch.tanh(W_h @ x + U_h @ (r * h))
    h = (1 - z) * h + z * h_tilde
    return h


def gru_sequence(xs, h, W, U, T):
    """Recurrence over the sequence (tier-2)."""
    for t in range(1, T):
        h = torch.tanh(W @ xs[t] + U @ h)
    return h
