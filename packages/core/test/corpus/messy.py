import logging
import torch

logger = logging.getLogger(__name__)


def messy_training_step(model, batch, optimizer, device, step):
    """A realistic function full of logging and plumbing (§6.5 discipline)."""
    logger.info("starting step %d", step)
    x = batch["input"].to(device)
    y = batch["target"].to(device)
    assert x.shape[0] == y.shape[0]
    optimizer.zero_grad()
    logits = model(x)
    probs = torch.softmax(logits, -1)
    loss = -torch.log(probs[y]).mean()
    loss.backward()
    optimizer.step()
    if step % 100 == 0:
        logger.info("loss=%f", loss.item())
    z = logits.detach()
    norm = torch.norm(z)
    return loss, norm


def half_translatable(x, w, cfg):
    print("debug", cfg)
    h = x @ w
    h.record_stats(reason="because")
    y = torch.tanh(h)
    return y
