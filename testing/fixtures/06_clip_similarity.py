# Adapted from OpenAI CLIP at commit d05afc4.
# Copyright (c) 2021 OpenAI.
# SPDX-License-Identifier: MIT


def similarity_logits(image_features, text_features, logit_scale):
    image_features = image_features / image_features.norm(dim=1, keepdim=True)
    text_features = text_features / text_features.norm(dim=1, keepdim=True)

    scale = logit_scale.exp()
    logits_per_image = scale * image_features @ text_features.t()
    logits_per_text = logits_per_image.t()
    return logits_per_image, logits_per_text
