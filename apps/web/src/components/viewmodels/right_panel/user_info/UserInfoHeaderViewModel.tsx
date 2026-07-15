/*
Copyright 2025 New Vector Ltd.
SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only
Please see LICENSE files in the repository root for full details.
*/

import { RoomMember, type User } from "matrix-js-sdk/src/matrix";
import { useCallback, useContext } from "react";

import { mediaFromMxc } from "../../../../customisations/Media";
import Modal from "../../../../Modal";
import ImageView from "../../../views/elements/ImageView";
import MatrixClientContext from "../../../../contexts/MatrixClientContext";
import { type Member } from "../../../views/right_panel/UserInfo";
import { useUserTimezone } from "../../../../hooks/useUserTimezone";
import UserIdentifierCustomisations from "../../../../customisations/UserIdentifier";
import { isPresenceEnabled } from "../../../../utils/presence";

export interface PresenceInfo {
    lastActiveAgo: number | undefined;
    currentlyActive: boolean | undefined;
    state: string | undefined;
}

export interface TimezoneInfo {
    timezone: string;
    friendly: string;
}

export interface UserInfoHeaderState {
    /**
     * callback function when selected user avatar is clicked in user info
     */
    onMemberAvatarClick: () => void;
    /**
     * Object containing information about the precense of the selected user
     */
    precenseInfo: PresenceInfo;
    /**
     * Boolean that show or hide the precense information
     */
    showPresence: boolean;
    /**
     *  Timezone object
     */
    timezoneInfo: TimezoneInfo | null;
    /**
     * Displayed identifier for the selected user
     */
    userIdentifier: string | null;
}
interface UserInfoHeaderViewModelProps {
    member: Member;
    roomId?: string;
}

/**
 * View model for the userInfoHeaderView
 * props
 * @see {@link UserInfoHeaderState} for more information about what this view model returns.
 */
export function useUserfoHeaderViewModel({ member, roomId }: UserInfoHeaderViewModelProps): UserInfoHeaderState {
    const cli = useContext(MatrixClientContext);

    const showPresence = isPresenceEnabled(cli);

    const precenseInfo: PresenceInfo = {
        lastActiveAgo: undefined,
        currentlyActive: undefined,
        state: undefined,
    };

    const timezoneInfo = useUserTimezone(cli, member.userId);

    const userIdentifier = UserIdentifierCustomisations.getDisplayUserIdentifier?.(member.userId, {
        roomId,
        withDisplayName: true,
    });

    const onMemberAvatarClick = useCallback(() => {
        const avatarUrl = (member as RoomMember).getMxcAvatarUrl
            ? (member as RoomMember).getMxcAvatarUrl()
            : (member as User).avatarUrl;

        const httpUrl = mediaFromMxc(avatarUrl).srcHttp;
        if (!httpUrl) return;

        const params = {
            src: httpUrl,
            name: (member as RoomMember).name || (member as User).displayName,
        };

        Modal.createDialog(ImageView, params, "mx_Dialog_lightbox", undefined, true);
    }, [member]);

    if (member instanceof RoomMember && member.user) {
        precenseInfo.state = member.user.presence;
        precenseInfo.lastActiveAgo = member.user.lastActiveAgo;
        precenseInfo.currentlyActive = member.user.currentlyActive;
    }

    return {
        onMemberAvatarClick,
        showPresence,
        precenseInfo,
        timezoneInfo,
        userIdentifier,
    };
}
