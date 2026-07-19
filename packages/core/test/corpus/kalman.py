import torch


def kalman_predict(x, P, F, Q):
    """Kalman filter prediction step."""
    x_hat = F @ x
    P_hat = F @ P @ F.T + Q
    return x_hat, P_hat


def kalman_update(x_hat, P_hat, z, H, R):
    """Kalman filter measurement update."""
    y = z - H @ x_hat
    S = H @ P_hat @ H.T + R
    K = P_hat @ H.T @ torch.linalg.inv(S)
    x = x_hat + K @ y
    P = P_hat - K @ H @ P_hat
    return x, P


def kalman_filter(x, P, F, Q, H, R, zs, T):
    """Full filter over a sequence: recurrence over t."""
    for t in range(1, T):
        x = F @ x
        P = F @ P @ F.T + Q
    return x, P
