# Adapted from gaasher/I-JEPA at commit 98b4ed2.
# Copyright (c) 2023 Gabriel Asher.
# SPDX-License-Identifier: MIT

import torch
import torch.nn.functional as F


class IJEPA:
    @torch.no_grad()
    def get_target_blocks(self, patches, aspect_ratio, scale):
        target_encoder = self.teacher_encoder.eval()
        target_embeddings = target_encoder(patches)
        target_embeddings = self.norm(target_embeddings)

        patch_height, patch_width = self.patch_shape
        target_count = int(patch_height * patch_width * scale)
        block_height = int(
            torch.sqrt(torch.tensor(target_count / aspect_ratio))
        )
        block_width = int(aspect_ratio * block_height)

        target_blocks = torch.zeros(
            (
                self.num_targets,
                patches.shape[0],
                block_height * block_width,
                patches.shape[2],
            ),
            device=target_embeddings.device,
            dtype=target_embeddings.dtype,
        )
        target_indices = []
        excluded_indices = []

        for block in range(self.num_targets):
            start_row = torch.randint(
                0,
                patch_height - block_height + 1,
                (1,),
            ).item()
            start_column = torch.randint(
                0,
                patch_width - block_width + 1,
                (1,),
            ).item()
            start = start_row * patch_width + start_column

            indices = []
            for row in range(block_height):
                for column in range(block_width):
                    index = start + row * patch_width + column
                    indices.append(index)
                    if index not in excluded_indices:
                        excluded_indices.append(index)

            target_indices.append(indices)
            target_blocks[block] = target_embeddings[:, indices, :]

        return target_blocks, target_indices, excluded_indices

    def get_context_block(
        self,
        patches,
        aspect_ratio,
        scale,
        excluded_indices,
    ):
        patch_height, patch_width = self.patch_shape
        context_count = int(patch_height * patch_width * scale)
        block_height = int(
            torch.sqrt(torch.tensor(context_count / aspect_ratio))
        )
        block_width = int(aspect_ratio * block_height)

        start_row = torch.randint(
            0,
            patch_height - block_height + 1,
            (1,),
        ).item()
        start_column = torch.randint(
            0,
            patch_width - block_width + 1,
            (1,),
        ).item()
        start = start_row * patch_width + start_column

        context_indices = []
        for row in range(block_height):
            for column in range(block_width):
                index = start + row * patch_width + column
                if index not in excluded_indices:
                    context_indices.append(index)

        return patches[:, context_indices, :]

    def forward(
        self,
        images,
        target_aspect_ratio,
        target_scale,
        context_aspect_ratio,
        context_scale,
    ):
        patches = self.patch_embed(images)
        patches = self.post_embed_norm(patches + self.position_embedding)

        targets, target_indices, excluded_indices = self.get_target_blocks(
            patches,
            target_aspect_ratio,
            target_scale,
        )
        context = self.get_context_block(
            patches,
            context_aspect_ratio,
            context_scale,
            excluded_indices,
        )
        context = self.norm(self.student_encoder(context))

        predictions = torch.zeros_like(targets)
        for block in range(self.num_targets):
            masked_targets = self.mask_token.repeat(
                images.shape[0],
                targets.shape[2],
                1,
            )
            masked_targets = (
                masked_targets
                + self.position_embedding[:, target_indices[block], :]
            )
            predictions[block] = self.predictor(context, masked_targets)

        return predictions, targets


def prediction_loss(predictions, targets):
    return F.mse_loss(predictions, targets)
